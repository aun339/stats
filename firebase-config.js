// Firebase initialization (modular SDK from the official CDN, no build step needed).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, updateDoc, onSnapshot, writeBatch,
  query, where, arrayUnion, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Web API keys identify your project; they are not secrets. Access is
// controlled by Firestore security rules and Authorized domains in the console.
const firebaseConfig = {
  apiKey: "AIzaSyBDkb4xxaQb1WTF-_p3v7XeZwfsvxiDYPs",
  authDomain: "texhub-48c20.firebaseapp.com",
  projectId: "texhub-48c20",
  storageBucket: "texhub-48c20.firebasestorage.app",
  messagingSenderId: "789408351670",
  appId: "1:789408351670:web:e28cfa91797cefca302d17"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

export {
  auth, db, provider,
  signInWithPopup, signOut, onAuthStateChanged,
  doc, collection, getDoc, updateDoc, onSnapshot, writeBatch,
  query, where, arrayUnion, serverTimestamp
};
