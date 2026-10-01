// Firebase initialization (modular SDK from the official CDN, no build step needed).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch,
  query, where, orderBy, arrayUnion, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Web API keys identify your project; they are not secrets. Access is
// controlled by Firestore security rules and Authorized domains in the console.

// ACTIVE: the Firebase project whose Google login already works (from rent-tracker).
const firebaseConfig = {
  apiKey: "AIzaSyCHTqw2YRwitCDZTXYLnq76Eu0CojEIs2Y",
  authDomain: "rental-7b444.firebaseapp.com",
  projectId: "rental-7b444",
  storageBucket: "rental-7b444.firebasestorage.app",
  messagingSenderId: "573012830060",
  appId: "1:573012830060:web:edd57625e2905ef6863549"
};

/* PREVIOUS (kept for reference): the original texhub-48c20 project.
const firebaseConfig = {
  apiKey: "AIzaSyBDkb4xxaQb1WTf-_p3v7XeZwfsvxiDYPs",
  storageBucket: "texhub-48c20.firebasestorage.app",
  messagingSenderId: "789408351670",
  appId: "1:789408351670:web:e28cfa91797cefca302d17",
  authDomain: location.hostname === "stats-l4qm.vercel.app" ? "stats-l4qm.vercel.app" : "texhub-48c20.firebaseapp.com",
  projectId: "texhub-48c20"
};
*/

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

export {
  auth, db, provider,
  signInWithPopup, signOut, onAuthStateChanged,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch,
  query, where, orderBy, arrayUnion, serverTimestamp
};
