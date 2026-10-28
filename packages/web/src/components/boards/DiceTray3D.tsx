/**
 * 快艇骰子的 3D 骰子托盘（three.js）。
 *
 * 视觉定调（主人拍板）：**只看得见点数那一面**，不要顶面/侧面的透视。
 * 所以用**正交相机正对 +Z 轴**——平行投影下射线与骰子侧面平行，
 * 侧面完全不可见，五颗骰子就是五个干干净净的正方形点数块。
 *
 * 但仍然是真 3D：
 * - 骰子是圆角立方体，边缘的倒角会吃到环境光（有瓷器的厚度感）；
 * - 掷骰时绕**视线轴自转**，是三维空间里的旋转，不是贴图转；
 * - 锁定状态用材质自发光（暖琥珀）表示，不靠位移，所以点击框永不偏移。
 *
 * 工程约束：
 * 1. **确定性**：不接物理引擎，落定时用四元数精确吸附到服务端点数。
 * 2. **一定会停下**：吸附由 `settleKey`（每掷一次必变）驱动 + 兜底超时，
 *    避免"点数没变 → 没触发吸附 → 一直转"（真机复现过）。
 * 3. **热区与画面同源**：点击热区用归一化百分比（NDC 投影），
 *    与 canvas 像素尺寸解耦；正交投影保证热区是精确的正方形，框不会歪。
 * 4. **按需渲染**：动画结束就停掉 rAF。
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DiceRow } from './DiceRow';

/** 五颗骰子的横向间距（世界单位）。 */
const SLOT_GAP = 1.36;
const DIE_SIZE = 1;
/** 落定动画时长。 */
const SETTLE_MS = 420;
const SETTLE_STAGGER = 55;
/** 翻滚最长时长：超过就强制吸附，防止任何漏更新导致一直转。 */
const MAX_SPIN_MS = 2400;
/** 骰子占托盘宽度的比例（决定取景远近）。 */
const ROW_FILL = 0.87;

export interface DiceTray3DProps {
  dice: number[];
  held: boolean[];
  /** 每次「掷骰」自增，用来触发翻滚 */
  rollToken: number;
  /** 服务端骰子状态指纹：每掷一次必变（round/rollsLeft/dice 组合），驱动吸附 */
  settleKey: string;
  canHold: boolean;
  onToggleHold: (index: number) => void;
}

/** 热区：归一化坐标（0–100，相对容器宽高的百分比） */
export interface SlotRect {
  xPct: number;
  yPct: number;
  sizePct: number;
}

interface DieView {
  mesh: THREE.Mesh;
  materials: THREE.MeshStandardMaterial[];
  slot: number;
  held: boolean;
  value: number;
  spinning: boolean;
  spinStart: number;
  spinFrom: THREE.Quaternion;
  settleFrom: THREE.Quaternion | null;
  settleTo: THREE.Quaternion | null;
  settleStart: number;
  settleDelay: number;
}

interface SceneBundle {
  resize: () => void;
  spin: () => void;
  setFaces: (dice: number[]) => void;
  setHeld: (held: boolean[]) => void;
  projectSlots: () => SlotRect[];
  dispose: () => void;
  canvas: HTMLCanvasElement;
}

/** 面材质顺序：BoxGeometry 的 [+X,-X,+Y,-Y,+Z,-Z]，用标准骰布局（对面相加为 7）。 */
const FACE_MATERIAL_ORDER = [3, 4, 1, 6, 2, 5] as const;

/** 3×3 网格点位（比例坐标），用于画点数贴图。 */
const PIP_POINTS: Record<number, Array<[number, number]>> = {
  0: [],
  1: [[0.5, 0.5]],
  2: [[0.3, 0.3], [0.7, 0.7]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.31, 0.26], [0.69, 0.26], [0.31, 0.5], [0.69, 0.5], [0.31, 0.74], [0.69, 0.74]],
};

function makePipTexture(value: number): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');

  const base = ctx.createLinearGradient(0, 0, size * 0.6, size);
  base.addColorStop(0, '#fffdf9');
  base.addColorStop(0.5, '#faf4e8');
  base.addColorStop(1, '#eee4d1');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // 圆角骰子的倒角会遮住边缘，这里再加一层柔和的四周暗角，整块面不至于死平
  const edge = ctx.createRadialGradient(size / 2, size / 2, size * 0.34, size / 2, size / 2, size * 0.74);
  edge.addColorStop(0, 'rgba(120, 96, 64, 0)');
  edge.addColorStop(1, 'rgba(120, 96, 64, 0.13)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);

  const radius = size * 0.076;
  for (const [px, py] of PIP_POINTS[value] ?? []) {
    const cx = px * size;
    const cy = py * size;
    const pip = ctx.createRadialGradient(
      cx - radius * 0.28, cy - radius * 0.32, radius * 0.1,
      cx, cy, radius * 1.1,
    );
    pip.addColorStop(0, '#54607a');
    pip.addColorStop(0.6, '#2c3547');
    pip.addColorStop(1, '#1c2331');
    ctx.fillStyle = pip;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = radius * 0.2;
    ctx.beginPath();
    ctx.arc(cx, cy + radius * 0.12, radius * 0.78, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 「点数 n 朝上（+Y）」的基准四元数。 */
function topFaceQuaternion(value: number): THREE.Quaternion {
  const q = new THREE.Quaternion();
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);
  switch (value) {
    case 6: return q.setFromAxisAngle(axisX, Math.PI);
    case 2: return q.setFromAxisAngle(axisX, -Math.PI / 2);
    case 5: return q.setFromAxisAngle(axisX, Math.PI / 2);
    case 3: return q.setFromAxisAngle(axisZ, Math.PI / 2);
    case 4: return q.setFromAxisAngle(axisZ, -Math.PI / 2);
    case 1:
    default: return q.identity();
  }
}

/** 把 +Y 的面转到 +Z（正对观众）。 */
const FRONT_TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

/** 目标朝向：点数面正对相机，**没有面内倾角**（否则点击框会和骰子对不齐）。 */
function targetQuaternion(value: number): THREE.Quaternion {
  return FRONT_TILT.clone().multiply(topFaceQuaternion(value));
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function createScene(host: HTMLDivElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  // 正交相机：平行投影，侧面不可见 → 只看到点数面
  const camera = new THREE.OrthographicCamera(-3, 3, 1.5, -1.5, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTexture;

  const hemi = new THREE.HemisphereLight(0xfffaf0, 0xcfc3ae, 0.75);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff4e2, 1.35);
  key.position.set(-2.4, 4.2, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdae4ff, 0.4);
  fill.position.set(3.4, 1.2, 5);
  scene.add(fill);

  const geometry = new RoundedBoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE, 4, 0.13);
  const pipTextures = new Map<number, THREE.Texture>();
  for (const face of FACE_MATERIAL_ORDER) pipTextures.set(face, makePipTexture(face));

  const dice: DieView[] = [];
  for (let slot = 0; slot < 5; slot++) {
    const materials = FACE_MATERIAL_ORDER.map(
      (face) =>
        new THREE.MeshStandardMaterial({
          map: pipTextures.get(face),
          roughness: 0.36,
          metalness: 0,
          envMapIntensity: 0.8,
        }),
    );
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.position.set((slot - 2) * SLOT_GAP, 0, 0);
    scene.add(mesh);
    dice.push({
      mesh, materials, slot, held: false, value: 0,
      spinning: false, spinStart: 0, spinFrom: new THREE.Quaternion(),
      settleFrom: null, settleTo: null, settleStart: 0, settleDelay: 0,
    });
  }

  let frame = 0;
  let disposed = false;
  let width = host.clientWidth || 1;
  let height = host.clientHeight || 1;

  const render = () => renderer.render(scene, camera);
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const axisZ = new THREE.Vector3(0, 0, 1);
  const tmpQuat = new THREE.Quaternion();

  const step = () => {
    if (disposed) return;
    frame = 0;
    const now = performance.now();
    let busy = false;

    for (const die of dice) {
      if (die.spinning) {
        const seconds = (now - die.spinStart) / 1000;
        // 只绕视线轴自转：读数面始终朝向观众，转起来像"轮盘"而不是翻滚
        const angle = (16 / 1.5) * (1 - Math.exp(-1.5 * seconds)) + 5 * seconds;
        tmpQuat.setFromAxisAngle(axisZ, angle);
        die.mesh.quaternion.copy(tmpQuat).multiply(die.spinFrom);

        if (now - die.spinStart > MAX_SPIN_MS) {
          die.settleFrom = die.mesh.quaternion.clone();
          die.settleTo = targetQuaternion(die.value > 0 ? die.value : 1);
          die.settleStart = now;
          die.settleDelay = 0;
          die.spinning = false;
        } else {
          busy = true;
        }
      }

      if (die.settleTo && die.settleFrom) {
        const raw = (now - die.settleStart - die.settleDelay) / SETTLE_MS;
        const progress = Math.min(1, Math.max(0, raw));
        if (progress > 0) {
          die.mesh.quaternion.slerpQuaternions(die.settleFrom, die.settleTo, easeOutCubic(progress));
        }
        if (progress >= 1) {
          die.mesh.quaternion.copy(die.settleTo).normalize();
          die.settleTo = null;
          die.settleFrom = null;
        } else {
          busy = true;
        }
      }
    }

    render();
    if (busy) frame = requestAnimationFrame(step);
  };

  const schedule = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(step);
  };

  const resize = () => {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    const aspect = width / height;
    renderer.setSize(width, height);
    // 横向必须装下 5 颗骰子：rowWidth 占画面宽度的 ROW_FILL
    const rowWidth = SLOT_GAP * 4 + DIE_SIZE;
    const viewHeight = Math.max(1.5, rowWidth / ROW_FILL / aspect);
    const halfH = viewHeight / 2;
    const halfW = halfH * aspect;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
    render();
  };

  const spin = () => {
    const reduce = prefersReducedMotion();
    const now = performance.now();
    for (const die of dice) {
      if (reduce || die.held) continue;
      die.spinning = true;
      die.spinStart = now;
      die.spinFrom.copy(die.mesh.quaternion);
      die.settleTo = null;
      die.settleFrom = null;
    }
    schedule();
  };

  /** 吸附到给定点数；对"点数没变"的骰子也幂等执行，保证一定能停下来。 */
  const setFaces = (values: number[]) => {
    const now = performance.now();
    values.forEach((value, index) => {
      const die = dice[index];
      if (!die) return;
      if (value > 0) die.value = value;
      const target = targetQuaternion(die.value > 0 ? die.value : 1);
      if (!die.spinning && die.settleTo === null && die.mesh.quaternion.angleTo(target) < 0.002) return;
      die.settleFrom = die.mesh.quaternion.clone();
      die.settleTo = target;
      die.settleStart = now;
      die.settleDelay = prefersReducedMotion() ? 0 : index * SETTLE_STAGGER;
      die.spinning = false;
      schedule();
    });
  };

  /** 锁定状态用自发光表示（不动位置，点击框才不会偏）。 */
  const setHeld = (held: boolean[]) => {
    held.forEach((isHeld, index) => {
      const die = dice[index];
      if (!die || die.held === isHeld) return;
      die.held = isHeld;
      for (const material of die.materials) {
        material.emissive.setHex(isHeld ? 0xffb648 : 0x000000);
        material.emissiveIntensity = isHeld ? 0.16 : 0;
        material.needsUpdate = true;
      }
    });
    render();
  };

  /** 归一化热区：NDC → 0–100%。正交投影下骰子是精确正方形，框不会歪。 */
  const projectSlots = (): SlotRect[] => {
    const project = (x: number, y: number) => {
      const v = new THREE.Vector3(x, y, 0).project(camera);
      return { x: (v.x * 0.5 + 0.5) * 100, y: (-v.y * 0.5 + 0.5) * 100 };
    };
    return dice.map((die) => {
      const cx = die.mesh.position.x;
      const center = project(cx, 0);
      const right = project(cx + DIE_SIZE * 0.5, 0);
      const left = project(cx - DIE_SIZE * 0.5, 0);
      return { xPct: center.x, yPct: center.y, sizePct: Math.abs(right.x - left.x) };
    });
  };

  resize();
  for (const die of dice) die.mesh.quaternion.copy(targetQuaternion(1));

  const dispose = () => {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    geometry.dispose();
    envTexture.dispose();
    pmrem.dispose();
    for (const texture of pipTextures.values()) texture.dispose();
    for (const die of dice) for (const material of die.materials) material.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
  };

  return { resize, spin, setFaces, setHeld, projectSlots, dispose, canvas: renderer.domElement };
}

export function DiceTray3D({
  dice,
  held,
  rollToken,
  settleKey,
  canHold,
  onToggleHold,
}: DiceTray3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bundleRef = useRef<SceneBundle | null>(null);
  const [failed, setFailed] = useState(false);
  const [slots, setSlots] = useState<SlotRect[]>([]);
  const firstRollRef = useRef(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let bundle: SceneBundle | null = null;
    try {
      bundle = createScene(host);
      bundleRef.current = bundle;
    } catch (error) {
      console.warn('[dice3d] WebGL 初始化失败，降级为平面骰子', error);
      setFailed(true);
      return;
    }

    const sync = () => {
      bundle!.resize();
      setSlots(bundle!.projectSlots());
    };
    sync();
    let raf = requestAnimationFrame(sync);

    const observer = new ResizeObserver(() => {
      sync();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(sync);
    });
    observer.observe(host);
    if (host.parentElement) observer.observe(host.parentElement);

    const onWindowResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(sync);
    };
    window.addEventListener('resize', onWindowResize);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    bundle.canvas.addEventListener('webglcontextlost', onContextLost);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      cancelAnimationFrame(raf);
      bundle!.canvas.removeEventListener('webglcontextlost', onContextLost);
      bundle!.dispose();
      bundleRef.current = null;
    };
  }, []);

  useEffect(() => {
    bundleRef.current?.setHeld(held);
  }, [held]);

  /**
   * 服务端骰子状态每次变化都吸附一次。
   * 不能只看"点数串是否变化"：第三次掷骰可能掷出和上次一样的点数，
   * 那时字符串不变 → 不吸附 → 骰子一直转（真机复现过）。
   * settleKey 含 round + rollsLeft，每掷一次必变。
   */
  useEffect(() => {
    bundleRef.current?.setFaces(dice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleKey]);

  useEffect(() => {
    if (!bundleRef.current) return;
    if (firstRollRef.current) {
      firstRollRef.current = false;
      bundleRef.current.setFaces(dice);
      return;
    }
    bundleRef.current.spin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rollToken]);

  if (failed) {
    return <DiceRow dice={dice} held={held} canHold={canHold} onToggleHold={onToggleHold} />;
  }

  return (
    <div className="dice-tray-3d">
      <div className="dice-canvas" ref={hostRef} aria-hidden="true" />
      <div className="dice-hit-layer">
        {slots.map((slot, index) => {
          // 0 表示这一手还没掷过：读屏要念「未掷」，不能念成「1 点」（审计 N9）。
          // 注意：真正的 0 得由棋盘原样传进来，别在调用方把 0 改写成 1。
          const value = Number(dice[index]) > 0 ? Number(dice[index]) : 0;
          const isHeld = !!held[index];
          return (
            <button
              key={index}
              type="button"
              className={`dice-hit ${isHeld ? 'is-held' : ''} ${value > 0 ? '' : 'is-blank'}`}
              style={{
                left: `${slot.xPct}%`,
                top: `${slot.yPct}%`,
                width: `${slot.sizePct}%`,
              }}
              onClick={() => canHold && onToggleHold(index)}
              disabled={!canHold}
              aria-pressed={isHeld}
              aria-label={`第 ${index + 1} 颗${value > 0 ? `，${value} 点` : '，未掷'}${
                isHeld ? '，已锁定' : ''
              }`}
              title={canHold ? (isHeld ? '点一下解锁' : '点一下锁定这颗') : undefined}
            >
              <span className="dice-hit-ring" aria-hidden="true" />
              <span className="dice-hit-pin" aria-hidden="true">
                {isHeld ? '锁' : ''}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default DiceTray3D;
