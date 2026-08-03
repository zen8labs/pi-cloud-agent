const UNIT = 40;
const PAD = 20;
const COS30 = UNIT * 0.8660254;
const SIN30 = UNIT * 0.5;

type Tone = "top" | "left" | "right";

type Cube = {
  x: number;
  y: number;
  z: number;
  solid?: boolean;
  float?: { delay: string; duration: string };
};

/** Voxels removed from the 3x3x3 monolith: a window on the right face, an arch at the near bottom corner. */
const CARVED = new Set(["2,1,1", "2,2,0"]);

/** Interior walls exposed by the carves, filled solid so the recesses read as depth. */
const INKED = new Set(["1,1,1", "1,2,0", "2,1,0"]);

/** Cubes drifting around the monolith; the one solid accent keeps the cluster from feeling uniform. */
const SATELLITES: Cube[] = [
  { x: -1, y: 2, z: 4, solid: true, float: { delay: "-0.6s", duration: "7s" } },
  { x: 4, y: 0, z: 5, float: { delay: "-2.4s", duration: "8s" } },
  { x: -2, y: 3, z: 1, float: { delay: "-1.1s", duration: "6.5s" } },
  { x: 5, y: 0, z: 2, float: { delay: "-3.8s", duration: "7.5s" } },
  { x: 0, y: 4, z: -1, float: { delay: "-2.9s", duration: "8.5s" } },
  { x: 3, y: 2, z: -2, float: { delay: "-4.6s", duration: "6s" } },
  { x: 6, y: 2, z: 1, float: { delay: "-1.7s", duration: "7.8s" } },
];

function key(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

/** Dimetric projection: vertical edges stay vertical, the view looks down the (1,1,1) diagonal. */
function project(px: number, py: number, pz: number): [number, number] {
  return [(px - py) * COS30, (px + py) * SIN30 - pz * UNIT];
}

function facePoints(x: number, y: number, z: number, tone: Tone): string {
  const corners =
    tone === "top"
      ? ([
          [x, y, z + 1],
          [x + 1, y, z + 1],
          [x + 1, y + 1, z + 1],
          [x, y + 1, z + 1],
        ] as const)
      : tone === "right"
        ? ([
            [x + 1, y, z],
            [x + 1, y + 1, z],
            [x + 1, y + 1, z + 1],
            [x + 1, y, z + 1],
          ] as const)
        : ([
            [x, y + 1, z],
            [x + 1, y + 1, z],
            [x + 1, y + 1, z + 1],
            [x, y + 1, z + 1],
          ] as const);
  return corners.map(([px, py, pz]) => project(px, py, pz).join(",")).join(" ");
}

/** A face is drawn only when no neighbour occludes it; the viewer sees the +x, +y, and +z planes. */
function visibleTones(c: Cube, occupied: Set<string>): Tone[] {
  const tones: Tone[] = [];
  if (!occupied.has(key(c.x + 1, c.y, c.z))) tones.push("right");
  if (!occupied.has(key(c.x, c.y + 1, c.z))) tones.push("left");
  if (!occupied.has(key(c.x, c.y, c.z + 1))) tones.push("top");
  return tones;
}

function buildCubes(): Cube[] {
  const cubes: Cube[] = [];
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 3; y++)
      for (let z = 0; z < 3; z++) {
        if (CARVED.has(key(x, y, z))) continue;
        cubes.push({ x, y, z, solid: INKED.has(key(x, y, z)) });
      }
  cubes.push({ x: 1, y: 1, z: 3 });
  cubes.push(...SATELLITES);
  // Painter's order: far cubes (small x+y+z) first so near ones overdraw them.
  return cubes.sort((a, b) => a.x + a.y + a.z - (b.x + b.y + b.z));
}

/** Solid faces shade the recess walls: lit top, mid left, dark right. */
function solidFill(tone: Tone): string {
  if (tone === "top") return "var(--foreground)";
  const mix = tone === "left" ? 85 : 70;
  return `color-mix(in oklab, var(--foreground) ${mix}%, var(--background))`;
}

function computeView(cubes: Cube[]) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of cubes)
    for (const dx of [0, 1])
      for (const dy of [0, 1])
        for (const dz of [0, 1]) {
          const [sx, sy] = project(c.x + dx, c.y + dy, c.z + dz);
          xs.push(sx);
          ys.push(sy);
        }
  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  return {
    minX,
    minY,
    width: Math.max(...xs) - minX + PAD,
    height: Math.max(...ys) - minY + PAD,
  };
}

/** Halftone shading: full-ink dots, with tone carried by dot size per face, like the reference print. */
function DotPattern({
  tone,
  tile,
  r,
  opacity,
  rotate,
}: {
  tone: Tone;
  tile: number;
  r: number;
  opacity: number;
  rotate?: number;
}) {
  return (
    <pattern
      id={`iso-dots-${tone}`}
      width={tile}
      height={tile}
      patternUnits="userSpaceOnUse"
      patternTransform={rotate ? `rotate(${rotate})` : undefined}
    >
      <rect width={tile} height={tile} fill="var(--background)" />
      <circle cx={tile / 2} cy={tile / 2} r={r} fill="var(--foreground)" opacity={opacity} />
    </pattern>
  );
}

function CubeGroup({ c, occupied }: { c: Cube; occupied: Set<string> }) {
  const faces = visibleTones(c, occupied).map((tone) => (
    <polygon
      key={tone}
      points={facePoints(c.x, c.y, c.z, tone)}
      fill={c.solid ? solidFill(tone) : `url(#iso-dots-${tone})`}
      stroke="var(--foreground)"
      strokeOpacity={c.solid ? 0.6 : 0.14}
    />
  ));
  if (!c.float) return <g>{faces}</g>;
  return (
    <g
      className="iso-float"
      style={{ animationDelay: c.float.delay, animationDuration: c.float.duration }}
    >
      {faces}
    </g>
  );
}

export function IsoMachine() {
  const cubes = buildCubes();
  const occupied = new Set(cubes.map((c) => key(c.x, c.y, c.z)));
  const view = computeView(cubes);
  return (
    <svg
      viewBox={`${view.minX} ${view.minY} ${view.width} ${view.height}`}
      className="h-full w-full"
      role="img"
      aria-label="Isometric machine built from cubes"
    >
      <defs>
        <pattern id="iso-grid" width={COS30 * 2} height={UNIT} patternUnits="userSpaceOnUse">
          <path
            d={`M ${COS30} 0 L ${COS30 * 2} ${SIN30} L ${COS30} ${UNIT} L 0 ${SIN30} Z`}
            fill="none"
            stroke="var(--foreground)"
            strokeOpacity={0.06}
          />
        </pattern>
        <DotPattern tone="top" tile={3.6} r={0.7} opacity={1} />
        <DotPattern tone="left" tile={3.2} r={1.07} opacity={1} rotate={45} />
        <DotPattern tone="right" tile={3.2} r={1.4} opacity={1} rotate={-45} />
      </defs>
      <rect
        x={view.minX}
        y={view.minY}
        width={view.width}
        height={view.height}
        fill="url(#iso-grid)"
      />
      {cubes.map((c) => (
        <CubeGroup key={key(c.x, c.y, c.z)} c={c} occupied={occupied} />
      ))}
    </svg>
  );
}
