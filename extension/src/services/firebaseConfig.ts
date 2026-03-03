/**
 * Firebase REST API configuration.
 *
 * Replace the placeholder values below with your Firebase project credentials.
 * Get these from: Firebase Console → Project Settings → General → Web API Key
 *
 * If left as placeholders, the extension runs in dev mode (no auth required).
 */

export const FIREBASE_API_KEY = "YOUR_FIREBASE_API_KEY";
export const FIREBASE_PROJECT_ID = "YOUR_FIREBASE_PROJECT_ID";

// REST endpoints (auto-constructed from the above)
export const FIREBASE_SIGN_IN_URL =
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;

export const FIREBASE_SIGN_UP_URL =
  `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;

export const FIREBASE_REFRESH_URL =
  `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

export const FIREBASE_SEND_VERIFICATION_URL =
  `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`;

export const FIREBASE_RESET_PASSWORD_URL =
  `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`;

export const FIREBASE_GET_USER_DATA_URL =
  `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`;

export const GOOGLE_AUTH_URL =
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=${FIREBASE_PROJECT_ID}.apps.googleusercontent.com&redirect_uri=https://${FIREBASE_PROJECT_ID}.firebaseapp.com/__/auth/handler&response_type=code&scope=email%20profile&access_type=offline`;

// Firebase REST API response types

export interface FirebaseSignInResponse {
  idToken: string;
  email: string;
  refreshToken: string;
  expiresIn: string;
  localId: string;
  registered?: boolean;
}

export interface FirebaseSignUpResponse {
  idToken: string;
  email: string;
  refreshToken: string;
  expiresIn: string;
  localId: string;
}

export interface FirebaseRefreshResponse {
  access_token: string;
  expires_in: string;
  token_type: string;
  refresh_token: string;
  id_token: string;
  user_id: string;
  project_id: string;
}

export interface FirebaseErrorResponse {
  error: {
    code: number;
    message: string;
    errors: Array<{ message: string; domain: string; reason: string }>;
  };
}
