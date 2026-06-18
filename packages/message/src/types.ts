export enum MessageType {
  GROUP_MESSAGE = "GroupMessage",
  FRIEND_MESSAGE = "FriendMessage",
  OTHER_MESSAGE = "OtherMessage",
}

export interface MessageMember {
  userId: string;
  nickname: string | null;
}

export interface Group {
  groupId: string;
  groupName: string | null;
  groupAvatar: string | null;
  groupOwner: string | null;
  groupAdmins: string[] | null;
  members: MessageMember[] | null;
}

export interface PlatformMetadata {
  name: string;
  description: string;
  id: string;
  supportStreamingMessage: boolean;
  supportProactiveMessage: boolean;
}

