export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  active: boolean;
  sourceType: string;
  sourceLabel: string;
  localExists: boolean;
  sandboxExists: boolean;
  pluginName: string;
  readonly: boolean;
}
