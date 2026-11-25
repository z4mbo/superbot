import type { ComponentType, ReactNode } from "react";

/** The person signed in to the hosted site; not an account on any of their servers. */
export type CloudUser = {
  id: string;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
};

export type CloudAccountState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: CloudUser };

/**
 * The central account service behind the hosted site. Everything outside `accounts/` goes through
 * this, so the service can change without touching the app; only its own folder loads its SDK.
 */
export interface CloudAccounts {
  /** The issuer of `getToken()` tokens: what a server operator sets as `SUPERBOT_CLOUD_ISSUER`. */
  issuer: string;
  /** Wraps the hosted app and mounts whatever the service needs. */
  Provider: ComponentType<{ children: ReactNode }>;
  /** The service's sign-in form, styled with the app's tokens. Only inside `Provider`. */
  SignIn: ComponentType;
  /** Only inside `Provider`. */
  useAccount(): CloudAccountState;
  /**
   * A short-lived token naming the signed-in account, sent to a server as a bearer with each
   * request. Null when signed out. Callers ask every time; the service caches and renews it.
   */
  getToken(): Promise<string | null>;
  signOut(): Promise<void>;
  /** A small JSON document kept with the account; where the workspace list lives for now. */
  readDocument(key: string): Promise<unknown>;
  writeDocument(key: string, value: unknown): Promise<void>;
}

/** Loads the configured account service. Called once, by the hosted build's entry. */
export function loadCloudAccounts(): Promise<CloudAccounts> {
  throw new Error("not implemented");
}
