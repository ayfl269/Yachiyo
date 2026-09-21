import {
  ComponentType,
  type MessageComponent,
  type PlainComponent,
  type ImageComponent,
  type RecordComponent,
  type VideoComponent,
  type FileComponent,
  type FaceComponent,
  type AtComponent,
  type AtAllComponent,
  type ReplyComponent,
  type JsonComponent,
  type ShareComponent,
  type LocationComponent,
  type ForwardComponent,
  type MusicComponent,
  type ContactComponent,
  type PokeComponent,
} from "./components.js";

export interface SerializedComponent {
  type: string;
  data: Record<string, unknown>;
}

const COMPONENT_TYPE_TO_SERIAL: Record<ComponentType, string> = {
  [ComponentType.Plain]: "text",
  [ComponentType.Image]: "image",
  [ComponentType.Record]: "record",
  [ComponentType.Video]: "video",
  [ComponentType.File]: "file",
  [ComponentType.Face]: "face",
  [ComponentType.At]: "at",
  [ComponentType.AtAll]: "at_all",
  [ComponentType.Node]: "node",
  [ComponentType.Nodes]: "nodes",
  [ComponentType.Poke]: "poke",
  [ComponentType.Reply]: "reply",
  [ComponentType.Forward]: "forward",
  [ComponentType.Json]: "json",
  [ComponentType.Share]: "share",
  [ComponentType.Music]: "music",
  [ComponentType.Location]: "location",
  [ComponentType.Contact]: "contact",
  [ComponentType.Unknown]: "unknown",
};

/** Read a string field, defaulting to "". */
function str(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Read an optional string field (undefined when absent/null). */
function optStr(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" ? v : undefined;
}

/** Read a number field, defaulting to 0 (accepts numeric strings). */
function num(data: Record<string, unknown>, key: string): number {
  const v = data[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * Built-in deserializers for the core component types, keyed by the serialized
 * `type` string. `registerComponentSerializer` may override any of these (or
 * add new custom types).
 */
const SERIAL_TO_COMPONENT: Map<string, (data: Record<string, unknown>) => MessageComponent> = new Map();

function registerBuiltin(type: string, fn: (data: Record<string, unknown>) => MessageComponent): void {
  SERIAL_TO_COMPONENT.set(type, fn);
}

registerBuiltin("text", (data) => ({
  type: ComponentType.Plain,
  text: str(data, "text"),
  toDict: () => ({ type: "text", data: { text: str(data, "text") } }),
}) as PlainComponent);

registerBuiltin("image", (data) => ({
  type: ComponentType.Image,
  file: optStr(data, "file"),
  url: optStr(data, "url"),
  path: optStr(data, "path"),
  toDict: () => ({ type: "image", data }),
}) as ImageComponent);

registerBuiltin("record", (data) => ({
  type: ComponentType.Record,
  file: optStr(data, "file"),
  url: optStr(data, "url"),
  path: optStr(data, "path"),
  text: optStr(data, "text"),
  toDict: () => ({ type: "record", data }),
}) as RecordComponent);

registerBuiltin("video", (data) => ({
  type: ComponentType.Video,
  file: str(data, "file"),
  cover: optStr(data, "cover"),
  path: optStr(data, "path"),
  toDict: () => ({ type: "video", data }),
}) as VideoComponent);

registerBuiltin("file", (data) => ({
  type: ComponentType.File,
  name: optStr(data, "name"),
  file: optStr(data, "file"),
  url: optStr(data, "url"),
  toDict: () => ({ type: "file", data }),
}) as FileComponent);

registerBuiltin("face", (data) => ({
  type: ComponentType.Face,
  id: num(data, "id"),
  toDict: () => ({ type: "face", data: { id: num(data, "id") } }),
}) as FaceComponent);

registerBuiltin("at", (data) => ({
  type: ComponentType.At,
  qq: (typeof data.qq === "number" || typeof data.qq === "string") ? data.qq : "",
  name: optStr(data, "name"),
  toDict: () => ({ type: "at", data }),
}) as AtComponent);

registerBuiltin("at_all", (data) => ({
  type: ComponentType.AtAll,
  qq: "all",
  toDict: () => ({ type: "at_all", data }),
}) as AtAllComponent);

registerBuiltin("reply", (data) => ({
  type: ComponentType.Reply,
  id: (typeof data.id === "number" || typeof data.id === "string") ? data.id : "",
  toDict: () => ({ type: "reply", data: { id: data.id } }),
}) as ReplyComponent);

registerBuiltin("poke", (data) => ({
  type: ComponentType.Poke,
  id: num(data, "id"),
  toDict: () => ({ type: "poke", data: { id: num(data, "id") } }),
}) as PokeComponent);

registerBuiltin("forward", (data) => ({
  type: ComponentType.Forward,
  id: str(data, "id"),
  toDict: () => ({ type: "forward", data: { id: str(data, "id") } }),
}) as ForwardComponent);

registerBuiltin("json", (data) => {
  const payload = (data.data && typeof data.data === "object" && !Array.isArray(data.data))
    ? (data.data as Record<string, unknown>)
    : data;
  return {
    type: ComponentType.Json,
    data: payload,
    toDict: () => ({ type: "json", data: payload }),
  } as JsonComponent;
});

registerBuiltin("share", (data) => ({
  type: ComponentType.Share,
  url: str(data, "url"),
  title: str(data, "title"),
  content: optStr(data, "content"),
  image: optStr(data, "image"),
  toDict: () => ({ type: "share", data }),
}) as ShareComponent);

registerBuiltin("location", (data) => ({
  type: ComponentType.Location,
  lat: num(data, "lat"),
  lon: num(data, "lon"),
  title: optStr(data, "title"),
  content: optStr(data, "content"),
  toDict: () => ({ type: "location", data }),
}) as LocationComponent);

registerBuiltin("music", (data) => ({
  type: ComponentType.Music,
  url: optStr(data, "url"),
  title: optStr(data, "title"),
  content: optStr(data, "content"),
  image: optStr(data, "image"),
  toDict: () => ({ type: "music", data }),
}) as MusicComponent);

registerBuiltin("contact", (data) => ({
  type: ComponentType.Contact,
  userId: str(data, "userId"),
  nickname: optStr(data, "nickname"),
  toDict: () => ({ type: "contact", data }),
}) as ContactComponent);

/**
 * Register (or override) a deserializer for a serialized component type.
 * Called by integrations that introduce custom component types; built-in types
 * already have deserializers registered above.
 */
export function registerComponentSerializer(
  type: string,
  deserializer: (data: Record<string, unknown>) => MessageComponent,
): void {
  SERIAL_TO_COMPONENT.set(type, deserializer);
}

export function serializeComponent(comp: MessageComponent): SerializedComponent {
  const serialType = COMPONENT_TYPE_TO_SERIAL[comp.type] ?? "unknown";
  const dict = comp.toDict();
  return { type: serialType, data: (dict.data as Record<string, unknown>) ?? {} };
}

export function deserializeComponent(serial: SerializedComponent): MessageComponent {
  const deserializer = SERIAL_TO_COMPONENT.get(serial.type);
  if (deserializer) return deserializer(serial.data ?? {});
  return { type: ComponentType.Unknown, toDict() { return { type: "unknown", data: serial.data }; } };
}

export function serializeComponents(comps: MessageComponent[]): SerializedComponent[] {
  return comps.map(serializeComponent);
}

export function deserializeComponents(serials: SerializedComponent[]): MessageComponent[] {
  return serials.map(deserializeComponent);
}
