export enum ComponentType {
  Plain = "Plain",
  Image = "Image",
  Record = "Record",
  Video = "Video",
  File = "File",
  Face = "Face",
  At = "At",
  AtAll = "AtAll",
  Node = "Node",
  Nodes = "Nodes",
  Poke = "Poke",
  Reply = "Reply",
  Forward = "Forward",
  Json = "Json",
  Share = "Share",
  Music = "Music",
  Location = "Location",
  Contact = "Contact",
  Unknown = "Unknown",
}

export interface MessageComponent {
  type: ComponentType;
  toDict(): Record<string, unknown>;
}

export interface PlainComponent extends MessageComponent {
  type: ComponentType.Plain;
  text: string;
}

export interface ImageComponent extends MessageComponent {
  type: ComponentType.Image;
  file?: string;
  url?: string;
  path?: string;
}

export interface RecordComponent extends MessageComponent {
  type: ComponentType.Record;
  file?: string;
  url?: string;
  path?: string;
  text?: string;
}

export interface VideoComponent extends MessageComponent {
  type: ComponentType.Video;
  file: string;
  cover?: string;
  path?: string;
}

export interface FileComponent extends MessageComponent {
  type: ComponentType.File;
  name?: string;
  file?: string;
  url?: string;
}

export interface FaceComponent extends MessageComponent {
  type: ComponentType.Face;
  id: number;
}

export interface AtComponent extends MessageComponent {
  type: ComponentType.At;
  qq: string | number;
  name?: string;
}

export interface AtAllComponent extends MessageComponent {
  type: ComponentType.AtAll;
  qq: "all";
}

export interface ReplyComponent extends MessageComponent {
  type: ComponentType.Reply;
  id: string | number;
  chain?: MessageComponent[];
  senderId?: string;
  senderNickname?: string;
  time?: number;
  messageStr?: string;
}

export interface NodeComponent extends MessageComponent {
  type: ComponentType.Node;
  id?: number;
  name?: string;
  uin?: string;
  content: MessageComponent[];
}

export interface NodesComponent extends MessageComponent {
  type: ComponentType.Nodes;
  nodes: NodeComponent[];
}

export interface PokeComponent extends MessageComponent {
  type: ComponentType.Poke;
  id: number;
}

export interface JsonComponent extends MessageComponent {
  type: ComponentType.Json;
  data: Record<string, unknown>;
}

export interface ShareComponent extends MessageComponent {
  type: ComponentType.Share;
  url: string;
  title: string;
  content?: string;
  image?: string;
}

export interface LocationComponent extends MessageComponent {
  type: ComponentType.Location;
  lat: number;
  lon: number;
  title?: string;
  content?: string;
}

export interface ForwardComponent extends MessageComponent {
  type: ComponentType.Forward;
  id: string;
}

export interface MusicComponent extends MessageComponent {
  type: ComponentType.Music;
  url?: string;
  title?: string;
  content?: string;
  image?: string;
}

export interface ContactComponent extends MessageComponent {
  type: ComponentType.Contact;
  userId: string;
  nickname?: string;
}
