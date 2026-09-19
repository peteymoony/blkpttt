/*
 * Blockpit Auth — Firebase edition
 * --------------------------------
 * Email/password sign-in via Firebase Auth. If the account does not exist
 * yet, it is created automatically, so the first "login" doubles as sign-up
 * and the same credentials keep working afterwards. Sessions persist in the
 * browser (Firebase's default) and pages call getSession() to skip the
 * login form for returning users.
 */
window.BlockpitAuth = (function () {
    'use strict';

    var FIREBASE_CONFIG = {
        apiKey: "AIzaSyB1mMhGmdjxpkB8C4FH_fGf2ewv6K78JCQ",
        authDomain: "new-pr-vibe.firebaseapp.com",
        projectId: "new-pr-vibe",
        storageBucket: "new-pr-vibe.firebasestorage.app",
        messagingSenderId: "816760644351",
        appId: "1:816760644351:web:7b5bab1214d0510b0422ca"
    };

    var MIN_PASSWORD_LENGTH = 6;
    var firebaseAuth = null;
    var initPromise = null;

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('Failed to load ' + src)); };
            document.head.appendChild(s);
        });
    }

    function initFirebase() {
        if (initPromise) return initPromise;
        initPromise = (async function () {
            try {
                await loadScript('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js');
                await loadScript('https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js');
                    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
                firebaseAuth = firebase.auth();
                return firebaseAuth;
            } catch (e) {
                console.warn('error');
                return null;
            }
        })();
        return initPromise;
    }

    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    /* Sign in with email + password; auto sign-up on first use. */
    async function signIn(email, password) {
        email = (email || '').trim();
        password = password || '';

        if (!email || !password) {
            throw { code: 'missing-fields' };
        }
        if (!isValidEmail(email)) {
            throw { code: 'invalid-email' };
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
            throw { code: 'weak-password' };
        }

        var auth = await initFirebase();
        if (!auth) throw { code: 'network' };

        try {
            var cred = await auth.signInWithEmailAndPassword(email, password);
            return { mode: 'firebase', user: cred.user };
        } catch (err) {
            var code = err && err.code;
            if (code === 'auth/user-not-found' || code === 'auth/invalid-credential' || code === 'auth/wrong-password') {
                try {
                    var created = await auth.createUserWithEmailAndPassword(email, password);
                    return { mode: 'firebase', user: created.user, created: true };
                } catch (err2) {
                    if (err2 && err2.code === 'auth/email-already-in-use') {
                        throw { code: 'wrong-password' };
                    }
                    throw { code: (err2 && err2.code) || 'unknown' };
                }
            }
            if (code === 'auth/invalid-email') throw { code: 'invalid-email' };
            if (code === 'auth/weak-password') throw { code: 'weak-password' };
            if (code === 'auth/too-many-requests') throw { code: 'too-many-requests' };
            if (code === 'auth/network-request-failed') throw { code: 'network' };
            throw { code: code || 'unknown' };
        }
    }

    /* Returns { email } for a signed-in user, or null. */
    async function getSession() {
        var auth = await initFirebase();
        if (!auth) return null;
        return new Promise(function (resolve) {
            var settled = false;
            var timer = setTimeout(function () {
                if (!settled) { settled = true; resolve(null); }
            }, 4000);
            auth.onAuthStateChanged(function (user) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(user ? { email: user.email } : null);
            });
        });
    }

    return {
        signIn: signIn,
        getSession: getSession,
        MIN_PASSWORD_LENGTH: MIN_PASSWORD_LENGTH,
        isConfigured: function () { return true; }
    };
})();
