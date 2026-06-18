export interface StarMetadata {
  name: string;
  author: string;
  desc: string;
  shortDesc: string;
  version: string;
  repo: string;
  modulePath: string;
  activated: boolean;
  config: Record<string, unknown>;
  handlerFullNames: string[];
  displayName: string;
  logoPath: string;
  supportPlatforms: string[];
}
