import type { AdapterConfigBase, OneBot11AdapterConfig } from "@yachiyo/platform/config.js";

/** Explicit adapter lists take precedence over the OneBot11 shorthand. */
export function getStartupAdapterConfigs(options: {
  adapters?: AdapterConfigBase[];
  onebot11?: Partial<OneBot11AdapterConfig>;
}, saved: AdapterConfigBase[] = []): AdapterConfigBase[] {
  if (saved.length > 0) {
    if (!options.onebot11 || options.adapters !== undefined) return saved;
    const overrides = Object.fromEntries(Object.entries(options.onebot11)
      .filter(([, value]) => value !== undefined));
    const candidates = saved.filter((config) => config.type === "onebot11");
    const id = options.onebot11.id ?? (candidates.length === 1 ? candidates[0].id : "onebot11");
    if (Object.keys(overrides).length > 0 && !candidates.some((config) => config.id === id)) {
      console.warn("[Bootstrap] OneBot11 startup overrides do not match a saved adapter. Specify onebot11.id when multiple instances are configured.");
    }
    return saved.map((config) => config.type === "onebot11" && config.id === id
      ? { ...config, ...overrides, type: "onebot11", id: config.id }
      : config);
  }
  if (options.adapters !== undefined) return options.adapters;
  if (!options.onebot11) return [];
  return [{
    id: "onebot11",
    direction: "forward",
    port: 8080,
    host: "127.0.0.1",
    ...options.onebot11,
    type: "onebot11",
  }];
}
