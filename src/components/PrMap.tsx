import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { Check, Code2, FileSymlink, FlaskConical, ListOrdered, Loader, Radar, Shield, Sparkles, X } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { FileData } from "react-diff-view";
import { SEVERITY_RANK, worstCounted, type ChangeMap, type Finding, type MapEdge, type Risk, type Severity, type WalkStep } from "../analysis";
import type { AffectedFile, BlastRadius } from "../api";
import { allReviewed, filePath, fileStats, findFile, hiddenKind, hunkKey, type HideRules } from "../diffUtils";
import { useAgent } from "../harness";
import { useElementWidth } from "../hooks";
import { fileIcon, SEVERITY } from "../icons";
import { DiffModeSwitch, type DiffMode } from "./DiffView";

interface Props {
  files: FileData[];
  steps?: WalkStep[];
  map?: ChangeMap;
  findings: Finding[];
  risks: Risk[];
  reviewed: Set<string>;
  hide: HideRules;
  generating?: { running: boolean; error?: string };
  canGenerate: boolean;
  onMode: (m: DiffMode) => void;
  onGenerate: () => void;
  /** Opens a guided review section. */
  onOpenStep: (i: number) => void;
  /** Opens a file in the Files view. */
  onOpenFile: (path: string) => void;
  /** Files outside the diff that import the changed ones, from the worktree. */
  radius?: { data?: BlastRadius; loading?: boolean; error?: string };
  /** Opens an unchanged file in the editor; missing without a worktree. */
  onOpenElsewhere?: (path: string) => void;
}

/** How far out from the changed files the map shows files that may be affected. */
type Reach = 0 | 1 | 2;
const REACH_KEY = "betterlgtm.mapReach";
function loadReach(): Reach {
  try {
    const v = localStorage.getItem(REACH_KEY);
    return v === "0" ? 0 : v === "2" ? 2 : 1;
  } catch {
    return 1;
  }
}

type Status = "add" | "modify" | "delete" | "rename";

interface FileInfo {
  path: string;
  name: string;
  dir: string;
  status: Status;
  add: number;
  del: number;
  role?: string;
  /** Guided review sections the file's changes are in, as indexes. */
  steps: number[];
  /** Indexes into `findings`, worst first. */
  findings: number[];
  worst?: Severity;
  risks: string[];
  reviewed: boolean;
  /** Set for files outside the diff that import changed ones. */
  affected?: AffectedFile;
}

/** A link on the map: from the agent, from the imports between changed files, or to an affected file. */
type ShownEdge = MapEdge & { source: "agent" | "imports" | "affected" };

const NODE_W = 230;
const NODE_H = 62;
const STATUS: Record<Status, { letter: string; label: string }> = {
  add: { letter: "A", label: "Added" },
  modify: { letter: "M", label: "Modified" },
  delete: { letter: "D", label: "Deleted" },
  rename: { letter: "R", label: "Renamed" },
};

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Everything the map shows about each changed file, from the diff, the guided review and the findings. */
function describeFiles(p: Props, reach: Reach): { infos: FileInfo[]; edges: ShownEdge[]; hiddenGenerated: number; affected: number } {
  // Generated files would only add noise; tests stay, since what they test is worth seeing.
  const shown = p.files.filter((f) => hiddenKind(f, { ...p.hide, tests: false }) !== "generated");
  const byPath = new Map<string, FileInfo>();
  const resolve = (path: string) => {
    const f = findFile(shown, path);
    return f ? byPath.get(filePath(f)) : undefined;
  };
  for (const f of shown) {
    const path = filePath(f);
    const s = fileStats(f);
    const keys = f.hunks.map((h) => hunkKey(f, h));
    byPath.set(path, {
      path,
      name: path.split("/").pop() ?? path,
      dir: dirOf(path),
      status: f.type === "add" || f.type === "delete" || f.type === "rename" ? f.type : "modify",
      add: s.add,
      del: s.del,
      steps: [],
      findings: [],
      risks: [],
      reviewed: allReviewed(keys, p.reviewed),
    });
  }
  // Roles are keyed by the path the agent wrote; match them the same way anchors are matched.
  for (const [path, role] of Object.entries(p.map?.roles ?? {})) {
    const info = resolve(path);
    if (info && !info.role) info.role = role;
  }
  p.steps?.forEach((s, i) => s.changes.forEach((a) => {
    const info = resolve(a.path);
    if (info && !info.steps.includes(i)) info.steps.push(i);
  }));
  p.findings.forEach((f, i) => f.anchors.forEach((a) => {
    const info = resolve(a.path);
    if (info && !info.findings.includes(i)) info.findings.push(i);
  }));
  p.risks.forEach((r) => r.anchors.forEach((a) => {
    const info = resolve(a.path);
    if (info && !info.risks.includes(r.area)) info.risks.push(r.area);
  }));
  for (const info of byPath.values()) {
    info.steps.sort((a, b) => a - b);
    info.findings.sort((a, b) => SEVERITY_RANK[p.findings[a].severity] - SEVERITY_RANK[p.findings[b].severity]);
    info.worst = worstCounted(p.findings, info.findings);
  }
  // An edge is drawn only when both ends are files on the map.
  const seen = new Set<string>();
  const edges: ShownEdge[] = [];
  const add = (from: string, to: string, e: Omit<ShownEdge, "from" | "to">) => {
    const id = `${from}\u0000${to}`;
    if (from === to || seen.has(id)) return;
    seen.add(id);
    edges.push({ ...e, from, to });
  };
  for (const e of p.map?.edges ?? []) {
    const from = resolve(e.from);
    const to = resolve(e.to);
    if (from && to) add(from.path, to.path, { ...e, source: "agent" });
  }
  // Imports the agent didn't mention, read from the code.
  for (const l of p.radius?.data?.links ?? []) {
    const from = byPath.get(l.from);
    const to = byPath.get(l.to);
    if (from && to && !seen.has(`${to.path}\u0000${from.path}`)) add(from.path, to.path, { kind: "imports", source: "imports" });
  }
  const changedCount = byPath.size;
  for (const a of p.radius?.data?.affected ?? []) {
    if (a.hops > reach || byPath.has(a.path)) continue;
    byPath.set(a.path, {
      path: a.path,
      name: a.path.split("/").pop() ?? a.path,
      dir: dirOf(a.path),
      status: "modify",
      add: 0,
      del: 0,
      steps: [],
      findings: [],
      risks: [],
      reviewed: false,
      affected: a,
    });
  }
  for (const info of byPath.values()) {
    for (const to of info.affected?.imports ?? []) {
      if (byPath.has(to)) add(info.path, to, { kind: info.affected?.test ? "tests" : "imports", source: "affected" });
    }
  }
  return { infos: [...byPath.values()], edges, hiddenGenerated: p.files.length - shown.length, affected: byPath.size - changedCount };
}

interface Layout {
  positions: Map<string, { x: number; y: number }>;
  groups: { dir: string; x: number; y: number; width: number; height: number }[];
}

/** Lays the files out with ELK: layered along the links, each directory in its own box. */
async function layout(infos: FileInfo[], edges: ShownEdge[]): Promise<Layout> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const dirs = [...new Set(infos.map((i) => i.dir))].sort();
  const leaf = (i: FileInfo) => ({ id: i.path, width: NODE_W, height: NODE_H });
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "18",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: dirs.map((dir) => ({
      id: `dir:${dir}`,
      layoutOptions: { "elk.padding": "[top=30,left=12,bottom=12,right=12]", "elk.spacing.nodeNode": "14" },
      children: infos.filter((i) => i.dir === dir).map(leaf),
    })),
    edges: edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
  const out = await elk.layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  const groups: Layout["groups"] = [];
  for (const g of out.children ?? []) {
    groups.push({ dir: g.id.slice(4), x: g.x ?? 0, y: g.y ?? 0, width: g.width ?? 0, height: g.height ?? 0 });
    for (const c of g.children ?? []) positions.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  }
  return { positions, groups };
}

type FileNodeData = { info: FileInfo; dim: boolean; selected: boolean };
type DirNodeData = { dir: string; dim: boolean };

const AffectedNode = memo(function AffectedNode({ data }: NodeProps<Node<FileNodeData>>) {
  const { info } = data;
  const a = info.affected!;
  const Icon = fileIcon(info.path);
  const names = a.imports.map((x) => x.split("/").pop()).join(", ");
  return (
    <div className={["pm-node", "pm-affected", data.dim ? "pm-dim" : "", data.selected ? "pm-sel" : ""].join(" ")} title={`${info.path}\nNot changed. It imports ${a.hops === 1 ? "changed files" : "files that import changed files"}.`}>
      <Handle type="target" position={Position.Left} className="pm-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="pm-handle" isConnectable={false} />
      <div className="pm-top">
        <Icon size={13} style={{ color: "var(--faint)" }} />
        <span className="pm-name ellipsis">{info.name}</span>
        {a.test && <span className="pm-tag" title="A test"><FlaskConical size={11} />Test</span>}
      </div>
      <div className="pm-bottom">
        <span className="pm-role ellipsis">{a.hops === 1 ? "Imports" : "Through"} <span className="mono">{names}</span></span>
      </div>
    </div>
  );
});

const FileNode = memo(function FileNode({ data }: NodeProps<Node<FileNodeData>>) {
  const { info } = data;
  const Icon = fileIcon(info.path);
  const sev = info.worst ? SEVERITY[info.worst] : undefined;
  const cls = ["pm-node", `pm-${info.status}`, info.worst ? `pm-sev-${info.worst}` : "", info.reviewed ? "pm-done" : "", data.dim ? "pm-dim" : "", data.selected ? "pm-sel" : ""].join(" ");
  return (
    <div className={cls} title={info.path}>
      <Handle type="target" position={Position.Left} className="pm-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="pm-handle" isConnectable={false} />
      <div className="pm-top">
        <span className="pm-status" title={STATUS[info.status].label}>{STATUS[info.status].letter}</span>
        <Icon size={13} className="tone-muted" />
        <span className="pm-name ellipsis">{info.name}</span>
        {info.reviewed && <Check size={13} className="tone-ok" aria-label="Reviewed" />}
        <span className="pm-stat mono"><span className="pm-a">+{info.add}</span> <span className="pm-d">−{info.del}</span></span>
      </div>
      <div className="pm-bottom">
        <span className="pm-role ellipsis">{info.role ?? <span className="pm-faint">{info.dir || "/"}</span>}</span>
        {info.risks.length > 0 && <Shield size={12} className="tone-high" aria-label={`Sensitive: ${info.risks.join(", ")}`} />}
        {sev && <span className={`pm-find ${sev.tone}`} title={`${info.findings.length} ${info.findings.length === 1 ? "finding" : "findings"}, worst ${sev.label.toLowerCase()}`}><sev.icon size={12} />{info.findings.length}</span>}
        {info.steps.slice(0, 3).map((s) => <span key={s} className="pm-step" title={`Section ${s + 1}`}>{s + 1}</span>)}
      </div>
    </div>
  );
});

const DirNode = memo(function DirNode({ data }: NodeProps<Node<DirNodeData>>) {
  return (
    <div className={data.dim ? "pm-dir pm-dim" : "pm-dir"}>
      <span className="pm-dir-label mono ellipsis">{data.dir || "/"}</span>
    </div>
  );
});

const nodeTypes = { file: FileNode, affected: AffectedNode, dir: DirNode };

function AffectedDetails(p: { info: FileInfo; onClose: () => void; onSelect: (path: string) => void; onOpenElsewhere?: (path: string) => void }) {
  const { info } = p;
  const a = info.affected!;
  const file = (path: string) => (
    <li key={path}>
      <button type="button" className="pm-link" onClick={() => p.onSelect(path)}><span className="mono">{path}</span></button>
    </li>
  );
  return (
    <aside className="pm-details selectable" aria-label={`Details for ${info.path}`}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{info.path}</div>
          <div className="muted" style={{ fontSize: 12 }}>Not changed{a.test ? " · Test" : ""} · {a.hops === 1 ? "imports a changed file" : "two imports away"}</div>
        </div>
        <button type="button" className="tb" aria-label="Close details" onClick={p.onClose}><X size={14} /></button>
      </div>
      <p style={{ margin: "8px 0 0" }}>
        {a.test
          ? "This test reaches the changed code, so it's worth checking it still covers the new behaviour."
          : "The PR doesn't touch this file, but it uses changed code, so its behaviour can change too."}
      </p>
      <h3>{a.hops === 1 ? "Imports" : "Through"}</h3>
      <ul>{a.imports.map(file)}</ul>
      {a.hops > 1 && (
        <>
          <h3>Depends on changes in</h3>
          <ul>{a.reaches.map(file)}</ul>
        </>
      )}
      <p className="muted" style={{ fontSize: 11, margin: "10px 0 0" }}>Found from the imports in the code, not by the agent.</p>
      {p.onOpenElsewhere && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
          <button type="button" className="btn sm" style={{ justifyContent: "flex-start" }} onClick={() => p.onOpenElsewhere?.(info.path)}>
            <Code2 size={13} />Open in VS Code
          </button>
        </div>
      )}
    </aside>
  );
}

function Details(p: { info: FileInfo; edges: ShownEdge[]; steps?: WalkStep[]; findings: Finding[]; onClose: () => void; onOpenStep: (i: number) => void; onOpenFile: (path: string) => void; onSelect: (path: string) => void }) {
  const { info } = p;
  const out = p.edges.filter((e) => e.from === info.path && e.source !== "affected");
  const inc = p.edges.filter((e) => e.to === info.path && e.source !== "affected");
  const users = p.edges.filter((e) => e.to === info.path && e.source === "affected").length;
  const name = (path: string) => path.split("/").pop() ?? path;
  const link = (e: ShownEdge, other: string, verb: string) => (
    <li key={`${e.from}-${e.to}`}>
      <button type="button" className="pm-link" onClick={() => p.onSelect(other)}>
        <span className="muted">{verb}</span> <span className="mono">{name(other)}</span>
      </button>
      {e.why ? <div className="muted">{e.why}</div> : e.source === "imports" && <div className="muted">Read from the imports</div>}
    </li>
  );
  return (
    <aside className="pm-details selectable" aria-label={`Details for ${info.path}`}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{info.path}</div>
          <div className="muted" style={{ fontSize: 12 }}>{STATUS[info.status].label} · +{info.add} −{info.del}{info.reviewed ? " · Reviewed" : ""}</div>
        </div>
        <button type="button" className="tb" aria-label="Close details" onClick={p.onClose}><X size={14} /></button>
      </div>
      {info.role && <p style={{ margin: "8px 0 0" }}>{info.role}</p>}
      {info.risks.length > 0 && <p className="tone-high" style={{ margin: "8px 0 0", fontSize: 12 }}><Shield size={12} style={{ verticalAlign: -2 }} /> Sensitive: {info.risks.join(", ")}</p>}
      {info.findings.length > 0 && (
        <>
          <h3>Findings</h3>
          <ul>
            {info.findings.map((i) => {
              const f = p.findings[i];
              const s = SEVERITY[f.severity];
              return <li key={i}><s.icon size={12} className={s.tone} style={{ verticalAlign: -2 }} /> {i + 1}. {f.title}</li>;
            })}
          </ul>
        </>
      )}
      {(out.length > 0 || inc.length > 0) && (
        <>
          <h3>Links</h3>
          <ul>
            {out.map((e) => link(e, e.to, e.kind))}
            {inc.map((e) => link(e, e.from, `${e.kind === "tests" ? "tested" : e.kind === "configures" ? "read" : e.kind === "renders" ? "rendered" : e.kind === "imports" ? "imported" : e.kind === "implements" ? "implemented" : "called"} by`))}
          </ul>
        </>
      )}
      {users > 0 && <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>{users} unchanged {users === 1 ? "file uses" : "files use"} it. They're shown in grey.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
        {info.steps.map((s) => (
          <button key={s} type="button" className="btn sm" style={{ justifyContent: "flex-start" }} onClick={() => p.onOpenStep(s)}>
            <ListOrdered size={13} /><span className="ellipsis">Section {s + 1}: {p.steps?.[s]?.title}</span>
          </button>
        ))}
        <button type="button" className="btn sm" style={{ justifyContent: "flex-start" }} onClick={() => p.onOpenFile(info.path)}>
          <FileSymlink size={13} />Open the file's diff
        </button>
      </div>
    </aside>
  );
}

function MapCanvas(p: Props) {
  const agent = useAgent().short;
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 700;
  const [reach, setReachState] = useState<Reach>(loadReach);
  const setReach = (r: Reach) => {
    setReachState(r);
    try {
      localStorage.setItem(REACH_KEY, String(r));
    } catch {
      // Only a preference; the map works without it.
    }
  };
  const { infos, edges, hiddenGenerated, affected } = useMemo(() => describeFiles(p, reach), [p.files, p.steps, p.map, p.findings, p.risks, p.reviewed, p.hide, p.radius?.data, reach]);
  // The layout only depends on which files there are and how they link, not on badges or review state.
  const shape = useMemo(() => JSON.stringify([infos.map((i) => i.path), edges.map((e) => [e.from, e.to])]), [infos, edges]);
  const [laid, setLaid] = useState<{ shape: string; layout: Layout } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const flow = useReactFlow();

  useEffect(() => {
    let live = true;
    layout(infos, edges)
      .then((l) => { if (live) { setLaid({ shape, layout: l }); setError(null); } })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [shape]);

  // Refit when the layout changes, after React Flow has measured the new nodes.
  useEffect(() => {
    if (laid) requestAnimationFrame(() => flow.fitView({ padding: 0.12, maxZoom: 1.1 }));
  }, [laid?.shape]);

  // What to light up: the hovered or selected file with its direct links, or the files of one section.
  const focus = useMemo(() => {
    const at = hover ?? selected;
    if (at) {
      const s = new Set([at]);
      edges.forEach((e) => { if (e.from === at) s.add(e.to); if (e.to === at) s.add(e.from); });
      return s;
    }
    if (step !== null) return new Set(infos.filter((i) => i.steps.includes(step)).map((i) => i.path));
    return null;
  }, [hover, selected, step, edges, infos]);

  const nodes = useMemo<Node[]>(() => {
    if (!laid) return [];
    const out: Node[] = [];
    for (const g of laid.layout.groups) {
      const dim = !!focus && !infos.some((i) => i.dir === g.dir && focus.has(i.path));
      out.push({ id: `dir:${g.dir}`, type: "dir", position: { x: g.x, y: g.y }, data: { dir: g.dir, dim }, style: { width: g.width, height: g.height }, selectable: false, draggable: false, zIndex: 0 });
    }
    for (const info of infos) {
      const pos = laid.layout.positions.get(info.path) ?? { x: 0, y: 0 };
      out.push({
        id: info.path,
        type: info.affected ? "affected" : "file",
        parentId: `dir:${info.dir}`,
        extent: "parent",
        position: pos,
        data: { info, dim: !!focus && !focus.has(info.path), selected: selected === info.path },
        style: { width: NODE_W, height: NODE_H },
        draggable: false,
        zIndex: 1,
      });
    }
    return out;
  }, [laid, infos, focus, selected]);

  const flowEdges = useMemo<Edge[]>(() => {
    const at = hover ?? selected;
    return edges.map((e) => {
      const lit = !!at && (e.from === at || e.to === at);
      const dim = !!focus && !(focus.has(e.from) && focus.has(e.to));
      return {
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        label: lit ? e.kind : undefined,
        className: [lit ? "pm-edge-lit" : "", dim ? "pm-edge-dim" : "", e.kind === "tests" ? "pm-edge-test" : "", e.source === "affected" ? "pm-edge-affected" : ""].join(" "),
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        zIndex: 2,
      };
    });
  }, [edges, hover, selected, focus]);

  const selectedInfo = selected ? infos.find((i) => i.path === selected) : undefined;
  const select = (path: string) => {
    setSelected(path);
    const n = flow.getInternalNode(path);
    if (n) flow.setCenter(n.internals.positionAbsolute.x + NODE_W / 2, n.internals.positionAbsolute.y + NODE_H / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: 250 });
  };

  const notice = !p.steps || !p.map ? (
    <div className="pm-notice">
      <Sparkles size={13} className="tone-accent" style={{ flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        {p.generating?.running
          ? `${agent} is linking the files…`
          : p.steps
            ? "This guided review was made before the map, so files aren't linked or described yet."
            : `${agent} links the files and says what each one does when it creates the guided review.`}
      </span>
      {p.generating?.running ? <Loader size={13} className="spin" /> : p.canGenerate && (
        <button type="button" className="btn sm" onClick={p.onGenerate}>{p.steps ? "Recreate guided review" : "Create guided review"}</button>
      )}
      {p.generating?.error && <span style={{ color: "var(--crit)" }}>{p.generating.error}</span>}
    </div>
  ) : null;

  return (
    <div ref={rootRef} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 34, padding: "0 8px 0 12px", borderBottom: "1px solid var(--line)", background: "var(--side)", flexShrink: 0, minWidth: 0, overflow: "hidden" }}>
        <DiffModeSwitch mode="map" onMode={p.onMode} compact={narrow} />
        {p.steps && p.steps.length > 0 && !narrow && (
          <select aria-label="Highlight a section" value={step ?? ""} onChange={(e) => setStep(e.target.value === "" ? null : Number(e.target.value))} className="pm-select">
            <option value="">All sections</option>
            {p.steps.map((s, i) => <option key={i} value={i}>{i + 1}. {s.title}</option>)}
          </select>
        )}
        {p.radius && (
          <select aria-label="Show files that may be affected" title="Unchanged files that import the changed ones, read from the code" value={reach} onChange={(e) => setReach(Number(e.target.value) as Reach)} className="pm-select">
            <option value={0}>Changed files only</option>
            <option value={1}>+ files that import them</option>
            <option value={2}>+ two imports away</option>
          </select>
        )}
        {p.radius?.loading && <Loader size={13} className="spin tone-muted" aria-label="Reading the imports" />}
        <span style={{ flex: 1 }} />
        {width >= 1000 && (
          <span className="pm-legend muted">
            <span><i className="pm-swatch pm-add" />Added</span>
            <span><i className="pm-swatch pm-modify" />Modified</span>
            <span><i className="pm-swatch pm-delete" />Deleted</span>
            {reach > 0 && affected > 0 && <span><i className="pm-swatch pm-swatch-affected" />May be affected</span>}
            {hiddenGenerated > 0 && <span title="Generated files aren't on the map. The Files view shows them.">{hiddenGenerated} generated left out</span>}
          </span>
        )}
      </div>
      {notice}
      {reach > 0 && <RadiusNote radius={p.radius} shown={affected} reach={reach} />}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }} className="pm-canvas">
        {error ? (
          <div className="empty"><span style={{ color: "var(--crit)" }}>Couldn't lay out the map: {error}</span></div>
        ) : !infos.length ? (
          <div className="empty">No changed files to map.</div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            nodesConnectable={false}
            nodesDraggable={false}
            elementsSelectable={false}
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            // Dragging pans from anywhere, files included. A press that moves less than this is still
            // a click, so a little hand shake doesn't lose the click on a file.
            paneClickDistance={4}
            onNodeMouseEnter={(_, n) => n.type !== "dir" && setHover(n.id)}
            onNodeMouseLeave={() => setHover(null)}
            onNodeClick={(_, n) => n.type !== "dir" && setSelected(n.id === selected ? null : n.id)}
            onNodeDoubleClick={(_, n) => {
              const info = infos.find((i) => i.path === n.id);
              if (!info) return;
              if (info.affected) p.onOpenElsewhere?.(info.path);
              else if (info.steps.length) p.onOpenStep(info.steps[0]);
              else p.onOpenFile(info.path);
            }}
            onPaneClick={() => setSelected(null)}
          >
            <Background gap={20} size={1} color="var(--line)" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        )}
        {!laid && !error && infos.length > 0 && <div className="empty" style={{ position: "absolute", inset: 0 }}><Loader size={18} className="spin" /></div>}
        {selectedInfo?.affected && <AffectedDetails info={selectedInfo} onClose={() => setSelected(null)} onSelect={select} onOpenElsewhere={p.onOpenElsewhere} />}
        {selectedInfo && !selectedInfo.affected && (
          <Details
            info={selectedInfo}
            edges={edges}
            steps={p.steps}
            findings={p.findings}
            onClose={() => setSelected(null)}
            onOpenStep={p.onOpenStep}
            onOpenFile={p.onOpenFile}
            onSelect={select}
          />
        )}
      </div>
    </div>
  );
}

/** One line on what the affected files are, or why there are none. */
function RadiusNote({ radius, shown, reach }: { radius?: Props["radius"]; shown: number; reach: Reach }) {
  if (!radius || radius.loading) return null;
  const d = radius.data;
  let text: string;
  if (radius.error) text = `Couldn't read the imports: ${radius.error}`;
  else if (!d) return null;
  else if (!d.languages.length) text = "Files that may be affected are found for TypeScript, JavaScript, Python, Go and Rust. This repository has none of them.";
  else if (!shown) text = reach === 1 ? "No other file imports the changed files." : "No other file imports the changed files, even two imports away.";
  else {
    const tests = d.affected.filter((a) => a.hops <= reach && a.test).length;
    text = `${shown} unchanged ${shown === 1 ? "file uses" : "files use"} the changed code${tests ? `, ${tests} of them ${tests === 1 ? "a test" : "tests"}` : ""}. Read from the imports in ${d.scanned.toLocaleString()} files${d.more ? `; ${d.more} more left out` : ""}${d.truncated ? "; the repository is too big to read all of it" : ""}.`;
  }
  return (
    <div className="pm-radius muted" role="status">
      <Radar size={13} style={{ flexShrink: 0 }} />
      <span>{text}</span>
    </div>
  );
}

/** The PR as a map: changed files grouped by directory, linked by how they depend on each other. */
export function PrMap(p: Props) {
  return (
    <ReactFlowProvider>
      <MapCanvas {...p} />
    </ReactFlowProvider>
  );
}
