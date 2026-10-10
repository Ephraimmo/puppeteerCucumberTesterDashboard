/* ==========================================================================
   Firebase bridge for the browser dashboard.

   This replaces talking to dashboard-server.js over HTTP on the same host with
   talking to Firebase instead — so this page works the same whether it's opened on
   the machine running the tests, or deployed somewhere else entirely and opened from
   a different computer. A local process (firebase-agent.js) on the machine with the
   actual project/Chrome/files does the real work and relays results back here.

   Exposes window.FB = { AGENT_ID, ready, fetch(url, options), watchLive(handlers) } — dashboard.js calls
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

    /* ---------------- live view of the test browser ---------------- */
    // Frames reach this page two ways (see firebase-live.js on the agent for the other half):
    //   direct - over a WebRTC data channel to the machine running the tests. Firebase only
    //            carries the handshake (live/signals), so frames arrive as fast as the network
    //            between the two machines allows.
    //   relay  - through the database (live/frame): slower, but it works wherever Firebase does.
    // The relay starts at once, and the direct connection takes over when it is up (and hands
    // back if it drops). Registering under live/viewers is what makes the agent produce frames
    // at all; Firebase removes the entry when this tab closes.
    var STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
    var DIRECT_SETUP_TIMEOUT_MS = 15000;
    var DIRECT_RETRY_MS = [3000, 10000, 30000, 60000, 60000, 60000]; // after the last one it stays on the relay
    var LINK_INTERVAL_MS = 1000;

    function plain(value) { return JSON.parse(JSON.stringify(value)); } // Realtime Database rejects undefined
    function jpegToBitmap(bytes) { return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })); }
    function base64ToBytes(base64) {
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    // handlers: onFrame({ bitmap, url, t, via, n } | null when the run ended), onStep({ scenario, step } | null)
    // and, about once a second, onLink({ via: 'direct' | 'relay' | 'none', fps, rtt }).
    // The page owns each bitmap it is given and must close() it when it replaces it.
    function watchLive(handlers) {
        var liveRef = db.ref('agents/' + AGENT_ID + '/live');
        var viewerRef = liveRef.child('viewers').push();
        var viewerId = viewerRef.key;
        var connectedRef = db.ref('.info/connected');
        var stopped = false;
        var newest = { e: 0, n: 0 };  // the newest frame shown: a late relay frame must never replace a newer direct one
        var via = 'none';             // how the frame on screen arrived
        var shown = 0;                // frames shown since the last onLink
        var decoding = false;
        var waiting = null;           // the newest frame that arrived while another one was being decoded
        var connection = null;        // the direct connection being set up, or the one that is up
        var agentDirect = false;      // whether the agent can make direct connections at all
        var failures = 0;
        var retryTimer = null;

        /* ---- showing frames ---- */

        // Only one decode runs at a time and only the newest frame waits for it, so a slow
        // device skips frames instead of falling further and further behind.
        function present(frame) {
            if (stopped) return;
            if (decoding) {
                if (waiting) waiting.release();
                waiting = frame;
                return;
            }
            decoding = true;
            // (a decode that throws at once, e.g. on corrupt base64, must not leave `decoding` set for good)
            new Promise(function (resolve) { resolve(frame.decode()); }).then(function (bitmap) {
                if (stopped || !(frame.e !== newest.e || frame.n > newest.n)) { bitmap.close(); return; }
                newest = { e: frame.e, n: frame.n };
                via = frame.via;
                shown += 1;
                handlers.onFrame({ bitmap: bitmap, url: frame.url, t: frame.t, via: frame.via, n: frame.n });
            }).catch(function () { /* a frame that won't decode is skipped */ }).then(function () {
                frame.release();
                decoding = false;
                var next = waiting;
                waiting = null;
                if (next) present(next);
            });
        }

        function onRelayFrame(snapshot) {
            var f = snapshot.val();
            if (!f || !f.data) {
                // the run ended — unless a direct connection is carrying the frames, which says so itself
                if (!(connection && connection.open)) { via = 'none'; handlers.onFrame(null); }
                return;
            }
            // an agent from before frames were numbered sends only the time it received them
            present({ e: f.e || 0, n: f.n || f.at || 0, t: f.t || f.at, url: f.url, via: 'relay', release: function () {}, decode: function () { return jpegToBitmap(base64ToBytes(f.data)); } });
        }

        function onRelayStep(snapshot) {
            if (!(connection && connection.open)) handlers.onStep(snapshot.val());
        }

        /* ---- the direct connection ---- */

        function endDirect(attempt, why) {
            if (attempt.ended) return;
            attempt.ended = true;
            clearTimeout(attempt.timeout);
            attempt.ref.child('answer').off();
            attempt.ref.child('agentIce').off();
            attempt.ref.onDisconnect().cancel();
            attempt.ref.remove().catch(function () {});
            try { attempt.pc.close(); } catch (error) { /* already closed */ }
            if (connection === attempt) connection = null;
            if (stopped) return;
            if (window.console) console.info('Live view: direct connection ended (' + why + ') — using the relay');
            // the agent notices on its side too, and goes back to serving this tab through the relay
            if (attempt.open) failures = 0; else failures += 1;
            if (agentDirect && failures <= DIRECT_RETRY_MS.length) {
                clearTimeout(retryTimer);
                retryTimer = setTimeout(startDirect, DIRECT_RETRY_MS[Math.max(0, failures - 1)]);
            }
        }

        // Frames arrive as messages of [u32 frame number][u16 index][u16 count][data]; the data
        // of one whole frame is [u32 header length][header JSON][JPEG].
        function onDirectChunk(attempt, buffer) {
            var view = new DataView(buffer);
            var n = view.getUint32(0), index = view.getUint16(4), count = view.getUint16(6);
            var part = new Uint8Array(buffer, 8);
            var assembly = attempt.assembly;
            if (!assembly || assembly.n !== n) assembly = attempt.assembly = { n: n, count: count, parts: [], received: 0 };
            if (!assembly.parts[index]) { assembly.parts[index] = part; assembly.received += 1; }
            if (assembly.received < assembly.count) return;
            attempt.assembly = null;

            var whole = part;
            if (assembly.count > 1) {
                var size = assembly.parts.reduce(function (total, piece) { return total + piece.length; }, 0);
                whole = new Uint8Array(size);
                var offset = 0;
                assembly.parts.forEach(function (piece) { whole.set(piece, offset); offset += piece.length; });
            }
            var headerLength = new DataView(whole.buffer, whole.byteOffset, whole.byteLength).getUint32(0);
            var header = JSON.parse(new TextDecoder().decode(whole.subarray(4, 4 + headerLength)));
            var jpeg = whole.subarray(4 + headerLength);
            failures = 0;
            // the ack, sent once the picture is decoded, tells the agent it may send the next one
            present({
                e: header.e, n: header.n, t: header.t, url: header.url, via: 'direct',
                decode: function () { return jpegToBitmap(jpeg); },
                release: function () {
                    try { attempt.channel.send(JSON.stringify({ ack: header.n })); }
                    catch (error) { /* the connection just closed */ }
                }
            });
        }

        function onDirectText(attempt, text) {
            var message;
            try { message = JSON.parse(text); }
            catch (error) { return; }
            if (message.type === 'ping') {
                // answer straight away (before any frame is decoded) so the agent measures the network, not us
                attempt.rtt = message.rtt || 0;
                try { attempt.channel.send(JSON.stringify({ pong: message.at })); }
                catch (error) { /* the connection just closed */ }
            }
            else if (message.type === 'step') handlers.onStep({ scenario: message.scenario, step: message.step });
            else if (message.type === 'end') { via = 'none'; handlers.onStep(null); handlers.onFrame(null); }
        }

        function startDirect() {
            if (stopped || connection || !agentDirect || !window.RTCPeerConnection) return;
            var ref = liveRef.child('signals').push();
            var pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
            var channel = pc.createDataChannel('live');
            channel.binaryType = 'arraybuffer';
            var attempt = { ref: ref, pc: pc, channel: channel, open: false, ended: false, answered: false, rtt: 0, assembly: null, timeout: null };
            connection = attempt;
            ref.onDisconnect().remove();
            attempt.timeout = setTimeout(function () { endDirect(attempt, 'no connection within ' + DIRECT_SETUP_TIMEOUT_MS / 1000 + ' s'); }, DIRECT_SETUP_TIMEOUT_MS);

            // The offer has to reach the agent before any candidate (it reads the node as soon as
            // it appears), so candidates found in the meantime wait until the offer is written.
            var offerWritten = false;
            var earlyCandidates = [];
            pc.onicecandidate = function (event) {
                if (!event.candidate || !event.candidate.candidate) return;
                var candidate = plain(event.candidate.toJSON());
                if (offerWritten) ref.child('viewerIce').push(candidate);
                else earlyCandidates.push(candidate);
            };
            pc.onconnectionstatechange = function () {
                if (pc.connectionState === 'failed' || pc.connectionState === 'closed') endDirect(attempt, 'the connection ' + pc.connectionState);
            };
            channel.onopen = function () {
                clearTimeout(attempt.timeout);
                attempt.open = true;
            };
            channel.onclose = function () { endDirect(attempt, 'the channel closed'); };
            channel.onmessage = function (event) {
                if (typeof event.data === 'string') onDirectText(attempt, event.data);
                else onDirectChunk(attempt, event.data);
            };

            ref.child('answer').on('value', function (snapshot) {
                var answer = snapshot.val();
                if (!answer || attempt.answered || attempt.ended) return;
                attempt.answered = true;
                pc.setRemoteDescription(answer).then(function () {
                    ref.child('agentIce').on('child_added', function (candidate) {
                        var value = candidate.val();
                        if (value && value.candidate) pc.addIceCandidate(value).catch(function () {});
                    });
                }).catch(function (error) { endDirect(attempt, error.message); });
            });

            pc.createOffer()
                .then(function (offer) { return pc.setLocalDescription(offer).then(function () { return offer; }); })
                .then(function (offer) {
                    var written = ref.set({ viewer: viewerId, offer: { type: offer.type, sdp: offer.sdp } });
                    offerWritten = true;
                    earlyCandidates.splice(0).forEach(function (candidate) { ref.child('viewerIce').push(candidate); });
                    return written;
                })
                .catch(function (error) { endDirect(attempt, error.message); });
        }

        // the agent says whether it can make direct connections; it clears the flag when it goes
        // away, which also tells us a connection to it is dead before the network notices
        function onDirectFlag(snapshot) {
            agentDirect = snapshot.val() === true;
            if (!agentDirect && connection) endDirect(connection, 'the agent went offline');
            else if (agentDirect && !connection) { failures = 0; startDirect(); }
        }

        /* ---- start / report / stop ---- */

        var linkTimer = setInterval(function () {
            handlers.onLink({ via: via, fps: shown, rtt: via === 'direct' && connection ? connection.rtt : 0 });
            shown = 0;
        }, LINK_INTERVAL_MS);

        // Firebase removes this entry on its server whenever the connection drops, even for a moment,
        // and the SDK reconnects by itself without redoing anything — so register again each time the
        // connection comes back, or the agent would stop sending to a tab that is still watching.
        function onConnected(snapshot) {
            if (snapshot.val() !== true || stopped) return;
            viewerRef.onDisconnect().remove()
                // (not if we stopped meanwhile: that would bring the entry back with nothing left to remove it)
                .then(function () { if (!stopped) return viewerRef.set({ since: firebase.database.ServerValue.TIMESTAMP }); })
                .catch(function () {});
        }
        connectedRef.on('value', onConnected);
        liveRef.child('frame').on('value', onRelayFrame);
        liveRef.child('step').on('value', onRelayStep);
        liveRef.child('direct').on('value', onDirectFlag);

        return function stopWatching() {
            stopped = true;
            clearInterval(linkTimer);
            clearTimeout(retryTimer);
            connectedRef.off('value', onConnected);
            liveRef.child('frame').off('value', onRelayFrame);
            liveRef.child('step').off('value', onRelayStep);
            liveRef.child('direct').off('value', onDirectFlag);
            if (connection) endDirect(connection, 'stopped watching');
            if (waiting) { waiting.release(); waiting = null; }
            viewerRef.onDisconnect().cancel();
            viewerRef.remove();
        };
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

    window.FB = { AGENT_ID: AGENT_ID, ready: readyPromise, fetch: fbFetch, watchLive: watchLive };
})();
