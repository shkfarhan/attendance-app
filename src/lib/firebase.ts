import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getAnalytics, isSupported } from "firebase/analytics";

const firebaseConfig = {
    apiKey: "AIzaSyCodeuGey8BsJLvs5oMsDi-UDqjBt9BKO0",
    authDomain: "recollectixattendance.firebaseapp.com",
    projectId: "recollectixattendance",
    storageBucket: "recollectixattendance.firebasestorage.app",
    messagingSenderId: "1092395628121",
    appId: "1:1092395628121:web:3c789a6c1899a85b5de348",
    measurementId: "G-C6W0NR7Y86"
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getFirestore(app);

let analytics;
if (typeof window !== "undefined") {
    isSupported().then((supported) => {
        if (supported) {
            analytics = getAnalytics(app);
        }
    });
}

export { app, auth, db, analytics };
