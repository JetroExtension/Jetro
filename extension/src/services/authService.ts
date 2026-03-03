import * as vscode from "vscode";
import {
  FIREBASE_API_KEY,
  FIREBASE_SIGN_IN_URL,
  FIREBASE_SIGN_UP_URL,
  FIREBASE_REFRESH_URL,
  FIREBASE_SEND_VERIFICATION_URL,
  FIREBASE_GET_USER_DATA_URL,
  type FirebaseSignInResponse,
  type FirebaseSignUpResponse,
  type FirebaseRefreshResponse,
  type FirebaseErrorResponse,
} from "./firebaseConfig";

export interface UserSession {
  uid: string;
  email: string;
  jwt: string;
  expiresAt: number; // epoch ms when JWT expires
  limits: {
    dataCallsRemaining: number;
    dataCallsMax: number;
    listsMax: number | null;       // null = unlimited
    projectsMax: number | null;
    recipesMax: number | null;
    datasourcesMax: number | null;
    portfoliosMax: number | null;
    cacheMb: number;
    cacheMaxMb: number;
  };
}

/**
 * Dev mode — bypasses Firebase auth entirely.
 * Returns true when no Firebase API key is configured (OSS default).
 * To enable real auth, set your Firebase API key in firebaseConfig.ts.
 */
function isDevMode(): boolean {
  return !FIREBASE_API_KEY || FIREBASE_API_KEY === "YOUR_FIREBASE_API_KEY";
}

/**
 * AuthService — Firebase REST API authentication.
 *
 * Uses Firebase Identity Toolkit REST API for sign-in/sign-up
 * and Secure Token API for token refresh. No Firebase SDK dependency.
 *
 * In dev mode (no Firebase key), auto-creates a HarryT session.
 *
 * Session persisted via VS Code SecretStorage (JWT, refreshToken)
 * and globalState (email, uid) across restarts.
 */
export class AuthService {
  private session: UserSession | null = null;
  private onChangeCallbacks: ((session: UserSession | null) => void)[] = [];

  constructor(
    private secrets: vscode.SecretStorage,
    private globalState: vscode.Memento,
    private outputChannel: vscode.OutputChannel
  ) {}

  /** Restore session from SecretStorage on boot. */
  async restore(): Promise<UserSession | null> {
    // Dev mode: auto-login
    if (isDevMode()) {
      this.session = {
        uid: "dev-local",
        email: "jetro@jetro.ai",
        jwt: "dev-token",
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
        limits: this.defaultLimits(),
      };
      this.outputChannel.appendLine("[auth] Dev mode — auto-logged in as HarryT");
      return this.session;
    }

    const savedEmail = this.globalState.get<string>("jet.auth.email");
    const savedUid = this.globalState.get<string>("jet.auth.uid");
    const savedJwt = await this.secrets.get("jet.auth.jwt");
    const savedRefresh = await this.secrets.get("jet.auth.refreshToken");

    if (savedEmail && savedJwt && savedUid) {
      const expiresAt = this.globalState.get<number>("jet.auth.expiresAt") ?? 0;

      // JWT expired — try to refresh
      if (Date.now() > expiresAt && savedRefresh) {
        try {
          await this.refreshToken(savedRefresh);
          this.outputChannel.appendLine(`[auth] Restored + refreshed session: ${savedEmail}`);
          return this.session;
        } catch {
          this.outputChannel.appendLine("[auth] Token refresh failed, session cleared");
          await this.signOut();
          return null;
        }
      }

      this.session = {
        uid: savedUid,
        email: savedEmail,
        jwt: savedJwt,
        expiresAt,
        limits: this.defaultLimits(),
      };
      this.outputChannel.appendLine(`[auth] Restored session: ${savedEmail}`);
      return this.session;
    }
    return null;
  }

  /** Sign in with email + password via Firebase REST API. */
  async signIn(email: string, password: string, staySignedIn: boolean = true): Promise<UserSession> {
    const res = await fetch(FIREBASE_SIGN_IN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });

    if (!res.ok) {
      const err = (await res.json()) as FirebaseErrorResponse;
      throw new Error(this.friendlyError(err.error?.message ?? "Sign-in failed"));
    }

    const data = (await res.json()) as FirebaseSignInResponse;

    // Check email verification
    const verified = await this.isEmailVerified(data.idToken);
    if (!verified) {
      // Re-send verification email in case they lost it
      await this.sendVerificationEmail(data.idToken);
      throw new Error("Please verify your email first. A new verification link has been sent.");
    }

    await this.clearPendingVerification();
    await this.buildSessionFromFirebase(data.localId, data.email, data.idToken, data.refreshToken, data.expiresIn, staySignedIn);
    this.outputChannel.appendLine(`[auth] Signed in: ${email} (stay=${staySignedIn})`);
    this.notifyChange();
    return this.session!;
  }

  /** Sign up with email + password via Firebase REST API. */
  async signUp(email: string, password: string, staySignedIn: boolean = true): Promise<UserSession> {
    const res = await fetch(FIREBASE_SIGN_UP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });

    if (!res.ok) {
      const err = (await res.json()) as FirebaseErrorResponse;
      throw new Error(this.friendlyError(err.error?.message ?? "Sign-up failed"));
    }

    const data = (await res.json()) as FirebaseSignUpResponse;

    // Send verification email — don't create a session yet
    await this.sendVerificationEmail(data.idToken);
    await this.setPendingVerification(email);
    this.outputChannel.appendLine(`[auth] Signed up: ${email} — verification email sent`);

    // Throw a special "success" error that the UI handles as a message
    throw new SignUpPendingVerification(email);
  }

  /** Sign in with Google — opens browser for OAuth flow. */
  async signInWithGoogle(): Promise<UserSession> {
    const email = await vscode.window.showInputBox({
      prompt: "Google SSO coming soon. Enter your email:",
      placeHolder: "you@example.com",
    });
    const password = await vscode.window.showInputBox({
      prompt: "Password",
      password: true,
    });

    if (!email || !password) {
      throw new Error("Sign-in cancelled");
    }

    return this.signIn(email, password);
  }

  /** Send a password reset email via Firebase. */
  async resetPassword(email: string): Promise<void> {
    const { FIREBASE_RESET_PASSWORD_URL } = await import("./firebaseConfig");
    const res = await fetch(FIREBASE_RESET_PASSWORD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestType: "PASSWORD_RESET", email }),
    });
    if (!res.ok) {
      const err = (await res.json()) as import("./firebaseConfig").FirebaseErrorResponse;
      const msg = err.error?.message || "Failed to send reset email";
      if (msg === "EMAIL_NOT_FOUND") {
        throw new Error("No account found with that email address");
      }
      throw new Error(msg);
    }
    this.outputChannel.appendLine(`[auth] Password reset email sent to ${email}`);
  }

  /** Sign out. Clears session from memory and SecretStorage. */
  async signOut(): Promise<void> {
    this.session = null;
    await this.secrets.delete("jet.auth.jwt");
    await this.secrets.delete("jet.auth.refreshToken");
    await this.globalState.update("jet.auth.email", undefined);
    await this.globalState.update("jet.auth.uid", undefined);
    await this.globalState.update("jet.auth.expiresAt", undefined);
    this.outputChannel.appendLine("[auth] Signed out");
    this.notifyChange();
  }

  /** Mark an email as pending verification (survives sidebar rebuilds). */
  async setPendingVerification(email: string): Promise<void> {
    await this.globalState.update("jet.auth.pendingVerification", email);
  }

  /** Clear the pending verification state (on successful sign-in or user dismissal). */
  async clearPendingVerification(): Promise<void> {
    await this.globalState.update("jet.auth.pendingVerification", undefined);
  }

  /** Get the email pending verification, if any. */
  getPendingVerificationEmail(): string | undefined {
    return this.globalState.get<string>("jet.auth.pendingVerification");
  }

  /** Get current session (null if not signed in). */
  getSession(): UserSession | null {
    return this.session;
  }

  /** Get a valid JWT. Auto-refreshes if within 5 min of expiry. */
  async getToken(): Promise<string | null> {
    if (!this.session) {
      return null;
    }

    // Dev mode tokens never expire
    if (isDevMode()) {
      return this.session.jwt;
    }

    const FIVE_MIN = 5 * 60 * 1000;
    if (Date.now() > this.session.expiresAt - FIVE_MIN) {
      const savedRefresh = await this.secrets.get("jet.auth.refreshToken");
      if (savedRefresh) {
        try {
          await this.refreshToken(savedRefresh);
          this.notifyChange(); // Update .mcp.json with fresh JWT
        } catch {
          this.outputChannel.appendLine("[auth] Token refresh failed");
          await this.signOut();
          return null;
        }
      }
    }

    return this.session.jwt;
  }

  /** Update limits from bootstrap response. */
  updateLimits(limits: UserSession["limits"]): void {
    if (this.session) {
      this.session.limits = limits;
    }
  }

  /** Subscribe to auth state changes. */
  onAuthStateChanged(callback: (session: UserSession | null) => void): void {
    this.onChangeCallbacks.push(callback);
  }

  // ── Private ──

  private async sendVerificationEmail(idToken: string): Promise<void> {
    try {
      await fetch(FIREBASE_SEND_VERIFICATION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestType: "VERIFY_EMAIL", idToken }),
      });
    } catch {
      // Non-critical — user can request another
    }
  }

  private async isEmailVerified(idToken: string): Promise<boolean> {
    try {
      const res = await fetch(FIREBASE_GET_USER_DATA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { users?: Array<{ emailVerified?: boolean }> };
      return data.users?.[0]?.emailVerified === true;
    } catch {
      return false;
    }
  }

  private async refreshToken(refreshToken: string): Promise<void> {
    const res = await fetch(FIREBASE_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });

    if (!res.ok) {
      throw new Error("Token refresh failed");
    }

    const data = (await res.json()) as FirebaseRefreshResponse;
    const expiresAt = Date.now() + parseInt(data.expires_in, 10) * 1000;
    const email = this.session?.email ?? this.globalState.get<string>("jet.auth.email") ?? "";

    this.session = {
      uid: data.user_id,
      email,
      jwt: data.id_token,
      expiresAt,
      limits: this.session?.limits ?? this.defaultLimits(),
    };

    await this.secrets.store("jet.auth.jwt", data.id_token);
    await this.secrets.store("jet.auth.refreshToken", data.refresh_token);
    await this.globalState.update("jet.auth.expiresAt", expiresAt);
    await this.globalState.update("jet.auth.uid", data.user_id);
  }

  private async buildSessionFromFirebase(
    uid: string, email: string, idToken: string, refreshToken: string, expiresIn: string, staySignedIn: boolean = true
  ): Promise<void> {
    const expiresAt = Date.now() + parseInt(expiresIn, 10) * 1000;

    this.session = {
      uid, email,
      jwt: idToken,
      expiresAt,
      limits: this.defaultLimits(),
    };

    await this.secrets.store("jet.auth.jwt", idToken);
    if (staySignedIn) {
      // Persist refresh token — session survives IDE restarts
      await this.secrets.store("jet.auth.refreshToken", refreshToken);
    } else {
      // Don't persist refresh token — session expires with JWT (~1 hour)
      await this.secrets.delete("jet.auth.refreshToken");
    }
    await this.globalState.update("jet.auth.email", email);
    await this.globalState.update("jet.auth.uid", uid);
    await this.globalState.update("jet.auth.expiresAt", expiresAt);
  }

  private defaultLimits(): UserSession["limits"] {
    return {
      dataCallsRemaining: 10_000, dataCallsMax: 10_000,
      listsMax: null, projectsMax: null, recipesMax: null,
      datasourcesMax: null, portfoliosMax: null, cacheMb: 0, cacheMaxMb: 2048,
    };
  }

  private friendlyError(msg: string): string {
    const map: Record<string, string> = {
      EMAIL_NOT_FOUND: "No account found with this email.",
      INVALID_PASSWORD: "Incorrect password.",
      USER_DISABLED: "This account has been disabled.",
      EMAIL_EXISTS: "An account with this email already exists.",
      WEAK_PASSWORD: "Password must be at least 6 characters.",
      INVALID_LOGIN_CREDENTIALS: "Invalid email or password.",
      TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Try again later.",
    };
    return map[msg] ?? msg;
  }

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      cb(this.session);
    }
  }
}

/** Thrown after successful sign-up to indicate verification email was sent. */
export class SignUpPendingVerification extends Error {
  constructor(public readonly email: string) {
    super(`Verification email sent to ${email}. Please check your inbox and verify before signing in.`);
    this.name = "SignUpPendingVerification";
  }
}
