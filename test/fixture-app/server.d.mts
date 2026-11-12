import type { FastifyInstance } from "fastify";

export interface FixtureUser {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly role: "customer" | "admin";
  readonly totpSecret?: string;
}

export declare const FIXTURE_USERS: {
  readonly plain: FixtureUser;
  readonly totp: FixtureUser & { readonly totpSecret: string };
};

export interface FixtureProduct {
  id: number;
  name: string;
  category: string;
  price: number;
  description: string;
}

export declare const FIXTURE_PRODUCTS: readonly FixtureProduct[];

export interface FixtureFlags {
  renameAddToCart: boolean;
  brokenCartBadge: boolean;
  captchaOnProducts: boolean;
  slowProductsMs: number;
}

export interface FixtureApp {
  url: string;
  port: number;
  app: FastifyInstance;
  flags: FixtureFlags;
  /** Every request as "METHOD /path" (test controls excluded). */
  requestLog: string[];
  setFlags(partial: Partial<FixtureFlags>): void;
  resetFlags(): void;
  expireSessions(): void;
  close(): Promise<void>;
}

export declare function startFixtureApp(options?: {
  host?: string;
  port?: number;
  flags?: Partial<FixtureFlags>;
}): Promise<FixtureApp>;
