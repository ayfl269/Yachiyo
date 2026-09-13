import { ComponentType, MessageComponent } from "./components.js";

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

// #59: 全仓当前没有任何 registerComponentSerializer 调用点，反序列化注册表
// 实际恒为空，round-trip（serialize → deserialize）会把组件退化为 Unknown。
// 反序列化导出路径不可用，首次调用时打一次 warn 提醒调用方。
let deserializerWarned = false;

function warnDeserializersEmptyOnce(): void {
  if (deserializerWarned) return;
  deserializerWarned = true;
  console.warn(
    "[message/serialize] Component deserializer registry is empty: no registerComponentSerializer() calls exist. " +
    "deserializeComponents() will degrade every component to Unknown — the deserialization export path is not usable.",
  );
}

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
  if (serials.length > 0) warnDeserializersEmptyOnce();
  return serials.map(deserializeComponent);
}
