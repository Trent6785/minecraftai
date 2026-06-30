// Firebase setup for multiplayer (Realtime Database).
// Note: this web config is not a secret — Firebase security is enforced by
// database rules, not by hiding these values. Before going public, we'll
// replace the open dev rules with proper locked-down rules.
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyCXRb85mcMiLwLEX4h1r0718aElFHUU7Qc",
  authDomain: "minecraft-ai-e4ffb.firebaseapp.com",
  databaseURL: "https://minecraft-ai-e4ffb-default-rtdb.firebaseio.com",
  projectId: "minecraft-ai-e4ffb",
  storageBucket: "minecraft-ai-e4ffb.firebasestorage.app",
  messagingSenderId: "691232255399",
  appId: "1:691232255399:web:bd17270d4db7f4c8911a82"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
