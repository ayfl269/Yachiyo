import { ComponentType, MessageComponent, PlainComponent, ImageComponent, RecordComponent, VideoComponent, FileComponent, FaceComponent, AtComponent, AtAllComponent, ReplyComponent, NodeComponent, NodesComponent, PokeComponent, JsonComponent, ShareComponent, LocationComponent, ForwardComponent, MusicComponent, ContactComponent } from "./components.js";

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

const SERIAL_TO_COMPONENT: Map<string, (data: Record<string, unknown>) => MessageComponent> = new Map();

export function registerComponentSerializer(
  type: string,
  deserializer: (data: Record<string, unknown>) => MessageComponent,
): void {
  SERIAL_TO_COMPONENT.set(type, deserializer);
}

export function serializeComponent(comp: MessageComponent): SerializedComponent {
  const serialType = COMPONENT_TYPE_TO_SERIAL[comp.type] ?? "unknown";
  return { type: serialType, data: comp.toDict().data as Record<string, unknown> ?? {} };
}

export function deserializeComponent(serial: SerializedComponent): MessageComponent {
  const deserializer = SERIAL_TO_COMPONENT.get(serial.type);
  if (deserializer) return deserializer(serial.data);
  return { type: ComponentType.Unknown, toDict() { return { type: "unknown", data: serial.data }; } };
}

export function serializeComponents(comps: MessageComponent[]): SerializedComponent[] {
  return comps.map(serializeComponent);
}

export function deserializeComponents(serials: SerializedComponent[]): MessageComponent[] {
  return serials.map(deserializeComponent);
}
