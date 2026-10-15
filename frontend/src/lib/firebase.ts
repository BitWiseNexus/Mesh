import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import { connectStorageEmulator, getStorage, type FirebaseStorage } from "firebase/storage";

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "demo-mesh";
const useEmulators = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";
// Emulator addresses (host:port); the defaults match firebase.json. The isolated e2e stack
// (firebase.e2e.json) runs them on other ports so it can run next to `npm run dev`.
const authEmulator = process.env.NEXT_PUBLIC_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const firestoreEmulator = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const storageEmulator = process.env.NEXT_PUBLIC_STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199";

function hostAndPort(address: string): [string, number] {
  const [host, port] = address.split(":");
  return [host, Number(port)];
}

const firebaseConfig = {
  // The emulators accept any API key for "demo-*" projects.
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "demo-api-key",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? `${projectId}.firebaseapp.com`,
  projectId,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? `${projectId}.appspot.com`,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

type FirebaseClients = { app: FirebaseApp; auth: Auth; db: Firestore; storage: FirebaseStorage };

let clients: FirebaseClients | undefined;

/** Lazily initialises Firebase in the browser. Emulators are connected exactly once. */
export function getFirebase(): FirebaseClients {
  if (clients) return clients;

  const isFirstInit = getApps().length === 0;
  const app = isFirstInit ? initializeApp(firebaseConfig) : getApp();
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app);

  if (useEmulators && isFirstInit) {
    connectAuthEmulator(auth, `http://${authEmulator}`, { disableWarnings: true });
    connectFirestoreEmulator(db, ...hostAndPort(firestoreEmulator));
    connectStorageEmulator(storage, ...hostAndPort(storageEmulator));
  }

  clients = { app, auth, db, storage };
  return clients;
}
