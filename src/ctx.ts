import type pg from "pg";
import type { Env } from "./config/env.js";
import type { SourceReader } from "./engine/types.js";
import type { ConfigStore } from "./services/configStore.js";
import type { TelegramGateway } from "./services/telegram.js";

export interface Logger {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

/** Everything a service needs. Tests build one with fakes for the reader, gateway and clock. */
export interface Ctx {
  env: Env;
  pool: pg.Pool;
  config: ConfigStore;
  reader: SourceReader;
  tg: TelegramGateway;
  now(): Date;
  log: Logger;
}

export const sourceIds = (ctx: Ctx): string[] => ctx.env.SOURCES_JSON.map((s) => s.id);
