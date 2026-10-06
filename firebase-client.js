/* ==========================================================================
   Firebase bridge for the browser dashboard.

   This replaces talking to dashboard-server.js over HTTP on the same host with
   talking to Firebase instead — so this page works the same whether it's opened on
   the machine running the tests, or deployed somewhere else entirely and opened from
   a different computer. A local process (firebase-agent.js) on the machine with the
   actual project/Chrome/files does the real work and relays results back here.

   Exposes window.FB = { AGENT_ID, ready, fetch(url, options) } — dashboard.js calls
   FB.fetch(...) exactly where it used to call the browser's own fetch(...); see the
   switch in fbFetch() below for how each endpoint maps to Firebase, and
   firebase-agent.js for the matching server-side half of each one.
   ========================================================================== */
(function () {
    'use strict';

    var firebaseConfig = {
        apiKey: 'AIzaSyBPqwi4EA0Ta746PiNfkmdHaJFikwFJJFA',
        authDomain: 'rfidproject-e2225.firebaseapp.com',
        databaseURL: 'https://rfidproject-e2225-default-rtdb.firebaseio.com',
        projectId: 'rfidproject-e2225',
        storageBucket: 'rfidproject-e2225.firebasestorage.app',
        messagingSenderId: '880640517617',
        appId: '1:880640517617:web:bb11c0c44aec8cb968d050'
    };
    // Lets one Firebase project host more than one local agent (e.g. two machines) —
    // override via ?agent=someId in the URL, remembered after that in localStorage.
    var params = new URLSearchParams(window.location.search);
    if (params.get('agent')) { try { localStorage.setItem('fb_agent_id', params.get('agent')); } catch (e) {} }
    var AGENT_ID = (function () { try { return localStorage.getItem('fb_agent_id') || 'main'; } catch (e) { return 'main'; } })();

    var COMMAND_TIMEOUT_MS = 20000;

    firebase.initializeApp(firebaseConfig);
    var auth = firebase.auth();
    var db = firebase.database();

    function $(id) { return document.getElementById(id); }

    function parseUrl(url) {
        var qIndex = url.indexOf('?');
        var path = qIndex === -1 ? url : url.slice(0, qIndex);
        var paramsObj = {};
        if (qIndex !== -1) {
            url.slice(qIndex + 1).split('&').forEach(function (pair) {
                if (!pair) return;
                var eq = pair.indexOf('=');
                var key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
                var value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
                paramsObj[key] = value;
            });
        }
        return { path: path, params: paramsObj };
    }

    function okResponse(body) {
        return { ok: true, status: 200, json: function () { return Promise.resolve(body); } };
    }
    function errResponse(status, message) {
        return { ok: false, status: status || 400, json: function () { return Promise.resolve({ message: message }); } };
    }

    function readOnce(dbPath) {
        return db.ref(dbPath).once('value').then(function (snap) { return snap.val(); });
    }

    // Pushes a command, then waits for the agent to flip its status away from
    // "pending" — this is effectively a request/response call over the database
    // instead of a direct HTTP request, since the browser can't reach the agent's
    // machine directly (it may not even be on the same network).
    function sendCommand(type, payload) {
        var ref = db.ref('commands/' + AGENT_ID).push();
        return ref.set({ type: type, payload: payload || {}, status: 'pending', createdAt: Date.now() })
            .then(function () {
                return new Promise(function (resolve, reject) {
                    var settled = false;
                    var timer = setTimeout(function () {
                        if (settled) return;
                        settled = true;
                        ref.off('value', onValue);
                        reject(new Error('The agent on your machine did not respond in time — is it running? (npm run agent)'));
                    }, COMMAND_TIMEOUT_MS);
                    function onValue(snapshot) {
                        var command = snapshot.val();
                        if (!command || command.status === 'pending' || settled) return;
                        settled = true;
                        clearTimeout(timer);
                        ref.off('value', onValue);
                        ref.remove().catch(function () {});
                        if (command.status === 'done') resolve(okResponse(command.result));
                        else resolve(errResponse(command.statusCode || 400, command.message || 'Command failed.'));
                    }
                    ref.on('value', onValue);
                });
            });
    }

    function fbFetch(url, options) {
        options = options || {};
        var method = (options.method || 'GET').toUpperCase();
        var parsed = parseUrl(url);
        var bodyObj = {};
        if (options.body) { try { bodyObj = JSON.parse(options.body); } catch (e) { bodyObj = {}; } }

        switch (parsed.path) {
            case '/api/progress':
                return readOnce('runs/' + AGENT_ID + '/progress').then(function (v) {
                    return okResponse(v || { status: 'idle', current: null, scenarios: [], counts: { passed: 0, failed: 0, running: 0, queued: 0 } });
                });
            case '/api/run-status':
                return readOnce('runs/' + AGENT_ID + '/status').then(function (v) {
                    return okResponse(v || { run: { status: 'idle', startedAt: null }, features: [] });
                });
            case '/api/report':
                return readOnce('reports/' + AGENT_ID).then(function (v) { return okResponse((v && v.report) || []); });
            case '/api/features':
                return readOnce('features/' + AGENT_ID).then(function (v) { return okResponse((v && v.files) || []); });
            case '/api/step-definitions':
                return readOnce('stepDefinitions/' + AGENT_ID).then(function (v) {
                    return okResponse({ files: (v && v.files) || [], steps: (v && v.steps) || [] });
                });
            case '/api/step-suggestions':
                return readOnce('agents/' + AGENT_ID + '/stepSuggestions').then(function (v) { return okResponse(v || []); });
            case '/api/env':
                return readOnce('agents/' + AGENT_ID + '/env').then(function (v) { return okResponse(v || { headlessOnly: true, platform: '', node: '' }); });
            case '/api/feature':
                if (method === 'GET') {
                    return readOnce('features/' + AGENT_ID).then(function (v) {
                        var match = ((v && v.files) || []).find(function (f) { return f.uri === parsed.params.file; });
                        return match ? okResponse(match) : errResponse(404, 'Feature file not found.');
                    });
                }
                if (method === 'DELETE') return sendCommand('deleteFeature', { file: parsed.params.file });
                if (method === 'POST') return sendCommand('saveFeature', bodyObj);
                break;
            case '/api/folder':
                if (method === 'POST') return sendCommand('createFolder', bodyObj);
                if (method === 'DELETE') return sendCommand('deleteFolder', { path: parsed.params.path });
                break;
            case '/api/step-definition':
                if (method === 'POST') return sendCommand('saveStepDefinition', bodyObj);
                if (method === 'PUT') return sendCommand('updateStepDefinition', bodyObj);
                break;
            case '/api/run':
                return sendCommand('run', bodyObj);
            case '/api/stop':
                return sendCommand('stop', {});
            case '/api/record/start':
                return sendCommand('startRecording', bodyObj);
            case '/api/record/request-step':
                return sendCommand('requestRecordStep', bodyObj);
            case '/api/record/stop':
                return sendCommand('stopRecording', bodyObj);
            case '/api/record/events':
                return readOnce('recording/' + AGENT_ID + '/session').then(function (session) {
                    var since = Number(parsed.params.since || 0);
                    var sameSession = session && session.sessionId === parsed.params.sessionId;
                    var events = (sameSession && session.events) || [];
                    return okResponse({ events: events.slice(since), total: events.length, closed: !!(sameSession && session.closed), error: (sameSession && session.error) || null });
                });
            default:
                break;
        }
        return Promise.resolve(errResponse(404, 'Unknown endpoint: ' + parsed.path));
    }

    /* ---------------- sign-in gate ---------------- */
    var readyResolve;
    var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

    function showAuthError(message) {
        var el = $('auth-error');
        el.textContent = message || '';
        el.classList.toggle('hidden', !message);
    }

    function wireAuthForm() {
        $('auth-form').addEventListener('submit', function (event) {
            event.preventDefault();
            var email = $('auth-email').value.trim();
            var password = $('auth-password').value;
            var submitBtn = $('auth-submit');
            submitBtn.disabled = true;
            showAuthError('');
            auth.signInWithEmailAndPassword(email, password)
                .catch(function (error) { showAuthError(error.message); })
                .then(function () { submitBtn.disabled = false; });
        });
        $('sign-out-btn').addEventListener('click', function () { auth.signOut(); });
    }

    auth.onAuthStateChanged(function (user) {
        if (user) {
            $('auth-overlay').classList.add('hidden');
            $('auth-user-email').textContent = user.email;
            $('auth-user-email').classList.remove('hidden');
            readyResolve();
        }
        else {
            $('auth-overlay').classList.remove('hidden');
            $('auth-user-email').classList.add('hidden');
        }
    });

    // This script tag sits at the end of <body>, so every element it references
    // above already exists in the DOM by the time this runs — no DOMContentLoaded
    // wrapper needed, consistent with how dashboard.js itself boots.
    wireAuthForm();

    window.FB = { AGENT_ID: AGENT_ID, ready: readyPromise, fetch: fbFetch };
})();
