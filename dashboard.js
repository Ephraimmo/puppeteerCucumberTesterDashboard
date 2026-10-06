/* ==========================================================================
   TestOps Console — dashboard logic
   Talks to the test agent through FB.fetch (see firebase-client.js), which relays
   each /api/* call over Firebase to firebase-agent.js on the test machine.
   ========================================================================== */
'use strict';

/* ---------------- state ---------------- */
var state = { progress: null, report: [], features: [], runStatus: null, env: { headlessOnly: true }, stepSuggestions: [] };
var activeFilter = 'all';
var studioFeature = null;
var studioOriginalUri = null;
var collapsed = {};
var openPanels = {}; // per-step "Show error" / "Screenshot" disclosure state, survives re-renders
var pendingFolders = []; // folder paths (relative to features/) created this session but not yet holding a saved file
var unsavedFiles = {}; // uri -> { name } for feature files created in the tree but not yet saved to disk
var pendingCreate = null; // { type: 'file'|'folder', parent, value, error } while the inline "new item" row is active
var reportQuery = ''; // live text from the Reports "find a feature, scenario, or step" search field
var stepDefs = { files: [], steps: [] }; // last-loaded /api/step-definitions response
var stepDefsLoaded = false;
var editingStep = null; // { file, source, flags } identifying the step currently loaded for editing, else null
var selectedStepDefFile = null; // file currently selected in the Explorer, whose steps are shown in the detail panel
var POLL_MS = 1500;
var RING_R = 52;
var RING_C = 2 * Math.PI * RING_R;

/* ---------------- tiny helpers ---------------- */
function $(id) { return document.getElementById(id); }
function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function icon(name) { return '<svg class="icon"><use href="#' + name + '"/></svg>'; }

function normalizeTagUI(value) {
    var s = String(value || '').trim();
    if (!s) return '';
    if (s.charAt(0) !== '@') s = '@' + s;
    if (!/^@[A-Za-z0-9_\-]+$/.test(s)) return '';
    return s;
}

function fmtTime(value) {
    if (!value) return '—';
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDuration(ms) {
    if (!ms && ms !== 0) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}
function fmtFeature(value) {
    if (!value) return '—';
    return String(value).split(/[\\/]/).pop();
}
function statusClass(s) {
    var known = ['idle', 'running', 'passed', 'failed', 'complete', 'waiting', 'queued'];
    return known.indexOf(s) >= 0 ? s : 'idle';
}
function runFinished() {
    var rs = state.runStatus && state.runStatus.run;
    if (!rs) return false;
    return rs.status === 'complete' || rs.status === 'failed' || (rs.status === 'idle' && (rs.finishedAt || rs.exitCode !== null));
}
function effectiveStatus() {
    var p = state.progress || {};
    var rs = state.runStatus && state.runStatus.run;
    var progStatus = p.status || 'idle';
    var runStatus = rs ? (rs.status || 'idle') : 'idle';
    // If the server-side run record is terminal (process exited), it is authoritative.
    if (runFinished()) {
        if (runStatus === 'complete') return 'passed';
        if (runStatus === 'failed') return 'failed';
        if (progStatus === 'running') return 'failed';
        return progStatus === 'idle' ? 'idle' : progStatus;
    }
    if (runStatus === 'running') return 'running';
    return progStatus === 'running' ? 'running' : (progStatus || 'idle');
}
function isBusy() {
    var rs = state.runStatus && state.runStatus.run;
    if (runFinished()) return false;
    return (rs && rs.status === 'running') || (state.progress && state.progress.status === 'running');
}

function emptyState(message, iconName) {
    return '<div class="empty-state">' +
        '<span class="empty-icon">' + icon(iconName || 'i-info') + '</span>' +
        '<span>' + esc(message) + '</span></div>';
}

/* ---------------- data shaping ---------------- */
function reportScenarios(report) {
    return (report || []).reduce(function (items, feature) {
        return items.concat((feature.elements || []).map(function (scenario) {
            var results = (scenario.steps || []).map(function (st) { return st.result && st.result.status; });
            return {
                name: scenario.name,
                featureFile: feature.uri,
                status: results.indexOf('failed') >= 0 ? 'failed' : 'passed',
                duration: (scenario.steps || []).reduce(function (t, st) { return t + ((st.result && st.result.duration) || 0); }, 0) / 1e6,
                steps: scenario.steps || []
            };
        }));
    }, []);
}
function liveScenarios() {
    var list = (state.progress && state.progress.scenarios) || [];
    // If the server confirmed the runner process exited, normalize any stray
    // "running"/"queued" scenarios to terminal status so UI badges don't stick.
    if (runFinished()) {
        return list.map(function (s) {
            if (s.status === 'running' || s.status === 'queued') {
                var hasFail = (s.steps || []).some(function (st) { return st.status === 'failed'; });
                var steps = (s.steps || []).map(function (st) {
                    if (st.status === 'running') {
                        return Object.assign({}, st, { status: hasFail ? 'failed' : 'passed' });
                    }
                    return st;
                });
                return Object.assign({}, s, {
                    steps: steps,
                    status: hasFail ? 'failed' : (s.status === 'queued' ? 'queued' : 'passed'),
                    finishedAt: s.finishedAt || new Date().toISOString()
                });
            }
            return s;
        });
    }
    return list;
}
function selectedFile() { return $('feature-select').value; }

function getScenarios() {
    var list = liveScenarios().length ? liveScenarios() : reportScenarios(state.report);
    var sel = selectedFile();
    return sel ? list.filter(function (s) { return !s.featureFile || fmtFeature(s.featureFile) === fmtFeature(sel); }) : list;
}

function outlineBasePattern(scenarioName) {
    var name = String(scenarioName || '');
    var stripped = name.replace(/<[A-Za-z_][A-Za-z0-9_-]*>/g, '').trim();
    stripped = stripped.replace(/\s*-\s*$/, '').trim();
    return stripped;
}
function matchOutlineEntries(baseName, allEntries) {
    var base = outlineBasePattern(baseName);
    if (!base) return [];
    var re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s*-\\s*.*)?$', 'i');
    return (allEntries || []).filter(function (e) {
        var n = String(e && e.name || '');
        if (re.test(n)) return true;
        return n.indexOf(base) === 0 && n.length > base.length;
    });
}
function aggregateStatus(statuses) {
    if (!statuses || !statuses.length) return null;
    if (statuses.indexOf('failed') >= 0) return 'failed';
    if (statuses.indexOf('running') >= 0) return 'running';
    if (statuses.every(function (s) { return s === 'passed'; })) return 'passed';
    if (statuses.some(function (s) { return s === 'passed' || s === 'failed'; })) return 'passed';
    return 'waiting';
}
function scenarioResultMerge(baseScenario, doneEntry) {
    if (!doneEntry) return baseScenario;
    var preserveKeys = ['name','keyword','tags','isOutline','examples','id','type','description'];
    var result = Object.assign({}, baseScenario);
    for (var k in doneEntry) {
        if (!doneEntry.hasOwnProperty(k)) continue;
        if (preserveKeys.indexOf(k) >= 0) continue;
        result[k] = doneEntry[k];
    }
    return result;
}
function mergeFeatureProgress(features, report) {
    var live = liveScenarios();
    // Once the run has finished, the JSON report is the authoritative source: it carries
    // per-step error messages and screenshot embeddings that the live progress feed never has.
    // Preferring stale "live" step data here would silently hide errors/screenshots after a run ends.
    var finished = runFinished();
    return features.map(function (feature) {
        var done = (report || []).filter(function (e) { return fmtFeature(e.uri) === fmtFeature(feature.uri); })[0];
        var bg = feature.background || (done && done.background) || null;
        if (!bg && done) {
            var doneBg = (done.elements || []).find(function (el) { return el && (el.type === 'background' || el.type === 'Background' || el.keyword === 'Background'); });
            if (doneBg) bg = { keyword: doneBg.keyword || 'Background', name: doneBg.name || '', steps: doneBg.steps || [] };
        }
        var doneElements = done && (done.elements || []).filter(function (el) {
            return !el || !((el.type && /background/i.test(el.type)) || (el.keyword && /Background/i.test(el.keyword)));
        }) || [];
        var liveElements = live.filter(function (e) {
            return !e.featureFile || fmtFeature(e.featureFile) === fmtFeature(feature.uri);
        });
        return {
            name: feature.name, uri: feature.uri, description: feature.description, tags: feature.tags,
            background: bg,
            elements: (feature.elements || []).map(function (scenario) {
                var lv = liveElements.filter(function (e) {
                    return e.name === scenario.name;
                })[0];
                var dn = doneElements.filter(function (e) { return e.name === scenario.name; })[0];
                var outline = isScenarioOutline(scenario);
                if (outline) {
                    var outlineLive = lv ? [lv] : matchOutlineEntries(scenario.name, liveElements);
                    var outlineDone = dn ? [dn] : matchOutlineEntries(scenario.name, doneElements);
                    if (!lv && outlineLive.length) {
                        lv = outlineLive[0];
                    }
                    if (!dn && outlineDone.length) {
                        dn = outlineDone[0];
                    }
                    var allStatuses = outlineLive.map(function (s) { return s.status || 'waiting'; })
                        .concat(outlineDone.map(function (s) { return scenarioStatus(s); }));
                    var outlineStatus = aggregateStatus(allStatuses);
                    var outlineDuration = outlineLive.reduce(function (t, s) { return t + (s.duration || 0); }, 0)
                        + outlineDone.reduce(function (t, s) { return t + scenarioDuration(s); }, 0);
                    var merged = scenarioResultMerge(scenario, dn);
                    var result = (lv && !finished) ? Object.assign({}, merged, {
                        progressStatus: lv.status,
                        progressDuration: lv.duration,
                        steps: (lv.steps && lv.steps.length) ? lv.steps : merged.steps
                    }) : merged;
                    if (outlineStatus && !result.progressStatus) result.progressStatus = outlineStatus;
                    if (outlineDuration && !result.progressDuration) result.progressDuration = outlineDuration;
                    if (outlineLive.length > 1 && !result.outlineCount) result.outlineCount = outlineLive.length;
                    else if (outlineDone.length > 1 && !result.outlineCount) result.outlineCount = outlineDone.length;
                    return result;
                }
                var merged = scenarioResultMerge(scenario, dn);
                return (lv && !finished) ? Object.assign({}, merged, {
                    progressStatus: lv.status,
                    progressDuration: lv.duration,
                    steps: (lv.steps && lv.steps.length) ? lv.steps : merged.steps
                }) : merged;
            })
        };
    });
}

function reportFeatures() {
    var sel = selectedFile();
    if (state.features.length) {
        return mergeFeatureProgress(state.features.filter(function (f) { return !sel || f.uri === sel; }), state.report);
    }
    if (state.report.length) {
        var filtered = state.report.filter(function (f) { return !sel || fmtFeature(f.uri) === fmtFeature(sel); });
        return filtered.map(function (feature) {
            var merged = mergeReportOutlines(feature);
            return Object.assign({}, feature, merged);
        });
    }
    var scs = getScenarios();
    return [{
        name: 'Latest live run', uri: (scs[0] && scs[0].featureFile) || '',
        elements: scs.map(function (s) { return { keyword: 'Scenario', name: s.name, progressStatus: s.status, progressDuration: s.duration, steps: s.steps || [] }; })
    }];
}

function isScenarioOutline(sc) {
    if (!sc) return false;
    if (sc.isOutline === true) return true;
    if (Array.isArray(sc.examples) && sc.examples.length > 0) return true;
    var kw = String(sc.keyword || '');
    if (/outline/i.test(kw)) return true;
    var nm = String(sc.name || '');
    if (/<[A-Za-z_][A-Za-z0-9_-]*>/.test(nm)) return true;
    return false;
}

function mergeReportOutlines(feature) {
    var elements = feature.elements || [];
    var placeholderPattern = /^(.+?)\s*-\s*(.+)$/;
    var groups = {};
    var order = [];
    elements.forEach(function (el, idx) {
        if (!el || (el.type && /background/i.test(el.type)) || (el.keyword && /Background/i.test(el.keyword))) return;
        var kw = String(el.keyword || '');
        if (/outline/i.test(kw)) {
            order.push({ idx: idx, groupKey: '__outline_' + idx, single: el });
            return;
        }
        var m = placeholderPattern.exec(el.name || '');
        if (m) {
            var base = m[1].trim();
            var val = m[2].trim();
            var key = 'outline:' + base;
            if (!groups[key]) {
                groups[key] = { base: base, keyword: kw || 'Scenario', tags: el.tags || [], steps: el.steps || [], examples: new Map(), exampleOrder: [], idx: idx };
                order.push({ idx: idx, groupKey: key, group: true });
            }
            var g = groups[key];
            if (!g.examples.has(val)) {
                g.examples.set(val, { value: val, status: scenarioStatus(el), el: el });
                g.exampleOrder.push(val);
            }
        } else {
            order.push({ idx: idx, groupKey: '__single_' + idx, single: el });
        }
    });
    var result = [];
    var bg = elements.find(function (el) { return el && ((el.type && /background/i.test(el.type)) || (el.keyword && /Background/i.test(el.keyword))); });
    order.forEach(function (entry) {
        if (entry.single) { result.push(entry.single); return; }
        var g = groups[entry.groupKey];
        if (!g) return;
        if (g.exampleOrder.length <= 1) {
            result.push(g.examples.get(g.exampleOrder[0]).el);
            return;
        }
        var placeholders = [];
        g.steps.forEach(function (st) {
            var nm = String(st.name || '');
            var re = /<([A-Za-z_][A-Za-z0-9_-]*)>/g, mm;
            while ((mm = re.exec(nm)) !== null) {
                if (placeholders.indexOf(mm[1]) < 0) placeholders.push(mm[1]);
            }
        });
        if (!placeholders.length) {
            g.exampleOrder.forEach(function (v) { result.push(g.examples.get(v).el); });
            return;
        }
        var variantCol = placeholders[0];
        var header = [variantCol];
        var body = g.exampleOrder.map(function (v) { return [v]; });
        result.push({
            keyword: 'Scenario Outline',
            name: g.base + ' - <' + variantCol + '>',
            tags: g.tags,
            steps: g.steps,
            isOutline: true,
            examples: [{ keyword: 'Examples', name: '', tags: [], header: header, body: body }]
        });
    });
    if (bg) result.unshift(bg);
    return { elements: result };
}

function outlineTableHtml(examples) {
    if (!Array.isArray(examples) || !examples.length) return '';
    return examples.map(function (ex) {
        var header = ex.header || [];
        var body = ex.body || [];
        if (!header.length && !body.length) return '';
        var widths = [];
        [header].concat(body).forEach(function (row) {
            (row || []).forEach(function (cell, i) {
                var len = String(cell == null ? '' : cell).length;
                if (!widths[i] || widths[i] < len) widths[i] = len;
            });
        });
        var headRow = '<tr>' + header.map(function (h) {
            return '<th><span class="ex-report-pill">' + esc(h) + '</span></th>';
        }).join('') + '</tr>';
        var bodyRows = body.map(function (row) {
            return '<tr>' + (row || []).map(function (c) {
                return '<td>' + esc(String(c == null ? '' : c)) + '</td>';
            }).join('') + '</tr>';
        }).join('');
        var countLabel = body.length + ' example' + (body.length === 1 ? '' : 's') + ' · ' + header.length + ' column' + (header.length === 1 ? '' : 's');
        var exName = String(ex.name || '').trim();
        return '<div class="report-outline-wrap">' +
            '<div class="report-outline-head">' +
            '<span class="report-outline-kicker">' + icon('i-table') + ' ' + esc(ex.keyword || 'Examples') + (exName ? ': ' + esc(exName) : ':') + '</span>' +
            '<span class="report-outline-count">' + countLabel + '</span>' +
            '</div>' +
            '<div class="report-outline-scroll"><table class="report-outline-table"><thead>' + headRow + '</thead><tbody>' + bodyRows + '</tbody></table></div>' +
            '</div>';
    }).join('');
}

function stepStatus(st) {
    return st && st.status ? st.status : st && st.result && st.result.status ? st.result.status : 'unknown';
}
function stepDurationMs(st) {
    if (st && st.result && typeof st.result.duration === 'number') return st.result.duration / 1e6;
    if (st && typeof st.duration === 'number') return st.duration;
    return null;
}
function stepErrorMessage(st) {
    if (!st) return '';
    if (st.result && st.result.error_message) return st.result.error_message;
    if (st.error_message) return st.error_message;
    return '';
}
function stepImages(st) {
    var embeds = (st && st.embeddings) || [];
    return embeds.filter(function (e) { return e && e.data && /^image\//.test(e.mime_type || ''); });
}
function scenarioHasShots(sc) {
    return (sc.steps || []).some(function (st) { return stepImages(st).length > 0; });
}
function scenarioStatus(sc) {
    if (sc.progressStatus) return sc.progressStatus;
    var has = (sc.steps || []).some(function (st) { return st.status || (st.result && st.result.status); });
    if (!has) return 'waiting';
    return (sc.steps || []).some(function (st) { return stepStatus(st) === 'failed'; }) ? 'failed' : 'passed';
}
function scenarioDuration(sc) {
    if (sc.progressDuration) return sc.progressDuration;
    return (sc.steps || []).reduce(function (t, st) { return t + ((st.result && st.result.duration) || 0); }, 0) / 1e6;
}
function scenarioTags(sc) {
    return (sc.tags || []).map(function (t) { return t.name || t; }).filter(Boolean);
}
function stateGlyph(status) {
    if (status === 'passed') return icon('i-check');
    if (status === 'failed') return icon('i-x');
    return '<span class="dotmark">·</span>';
}

/* ---------------- sticky offsets (studio header + file explorer) ---------------- */
// The site header's height varies (it wraps on narrow screens, and shows/hides the
// windowed-mode hint), so the studio header and file explorer stick to a measured
// offset rather than a hardcoded one.
function syncStickyOffsets() {
    var header = document.querySelector('.site-header');
    // Scoped to the currently visible view: Feature Studio and Step Definitions both use
    // a ".studio-header", and an unscoped query would always grab whichever one is first
    // in the DOM (possibly the hidden one, which measures 0).
    var studioHeader = document.querySelector('.view:not(.hidden) .studio-header');
    var headerH = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty('--header-h', headerH + 'px');
    if (studioHeader) {
        var studioH = Math.ceil(studioHeader.getBoundingClientRect().height);
        document.documentElement.style.setProperty('--studio-sticky-top', (headerH + studioH) + 'px');
    }
}
window.addEventListener('resize', syncStickyOffsets);

/* ---------------- render: overview ---------------- */
function render() {
    var progress = state.progress || { status: 'idle', counts: { passed: 0, failed: 0, running: 0, queued: 0 }, scenarios: [] };
    var scs = getScenarios();
    var counts = Object.assign({ passed: 0, failed: 0, running: 0, queued: 0 }, progress.counts || {});
    // If the run is finished on the server, any remaining "running" counts are stale —
    // move them into failed (since they never reached afterScenario cleanly).
    // This ensures counts + status pill stop spinning when the server confirms the run is done.
    var finished = runFinished();
    if (finished && counts.running > 0) {
        counts.failed += counts.running;
        counts.running = 0;
    }
    var total = scs.length;
    var completed = counts.passed + counts.failed;
    var pct = total ? Math.round(completed / total * 100) : 0;
    var status = effectiveStatus();
    var progCurrent = (finished ? null : progress.current);
    var runningSc = scs.filter(function (s) { return !finished && s.status === 'running'; })[0];
    var current = progCurrent || runningSc;
    var currentName = typeof current === 'string' ? current : current && current.name;
    var busy = isBusy();

    // status pill + run controls
    $('status-badge').className = 'status-pill ' + statusClass(status);
    $('status-text').textContent = String(status).toUpperCase();
    $('run-feat').classList.toggle('hidden', busy);
    $('run-batch').classList.toggle('hidden', busy);
    $('stop-run').classList.toggle('hidden', !busy);

    // global progress bar
    $('global-progress-bar').style.width = (busy ? Math.max(pct, 2) : 0) + '%';

    // run card
    $('run-title').textContent = status === 'running' ? 'Scenario run in motion' : status === 'idle' ? 'Waiting for scenarios' : 'Latest run complete';
    var runId = progress.runId ? '#' + String(progress.runId).replace(/\D/g, '').slice(0, 12) : '—';
    $('run-id').textContent = runId;
    $('run-id-meta').textContent = runId;
    $('progress-value').textContent = pct + '%';
    $('ring-fill').style.strokeDasharray = RING_C;
    $('ring-fill').style.strokeDashoffset = RING_C * (1 - pct / 100);

    var stClass = statusClass(currentName ? 'running' : (status === 'idle' ? 'idle' : status));
    $('current-status').className = 'live-tag ' + stClass;
    $('current-status-text').textContent = currentName ? 'Executing now' : (status === 'idle' ? 'Stand by' : 'Run complete');
    $('current-scenario').textContent = currentName || 'No scenario is running';
    $('current-detail').textContent = currentName
        ? 'The runner is moving through its steps. Results will land here as each scenario exits.'
        : status === 'idle'
            ? 'Start a tagged or feature-specific run and this console will follow every scenario as it moves through its steps.'
            : 'Every observed scenario has reported back. Review the stream below for the detail.';

    $('started-at').textContent = fmtTime(progress.startedAt);
    var end = (progress.updatedAt && status !== 'running') ? new Date(progress.updatedAt) : new Date();
    $('elapsed').textContent = progress.startedAt ? fmtDuration(end.getTime() - new Date(progress.startedAt).getTime()) : '—';

    // stats
    $('passed').textContent = counts.passed;
    $('failed').textContent = counts.failed;
    $('running').textContent = counts.running;
    $('total').textContent = total;

    // health
    var health = completed ? Math.round(counts.passed / completed * 100) : 0;
    $('health-score').textContent = completed ? health + '%' : '—';
    $('health-copy').textContent = completed
        ? (counts.failed ? counts.failed + ' scenario' + (counts.failed === 1 ? '' : 's') + ' need attention.' : 'All completed scenarios passed cleanly.')
        : 'No completed scenarios yet.';
    $('health-bar').style.width = health + '%';
    $('health-pass').textContent = counts.passed;
    $('health-fail').textContent = counts.failed;
    $('health-queued').textContent = counts.queued;

    renderStream(scs);
    renderQueue();
    renderReports();
    renderSelects();
    renderModeHint();
    syncStickyOffsets();
}

function renderModeHint() {
    var active = document.querySelector('#browser-mode .seg-btn.active');
    var windowed = active && active.dataset.mode === 'windowed';
    $('mode-hint').classList.toggle('hidden', !(windowed && state.env.headlessOnly));
}

/* ---------------- render: stream ---------------- */
function renderStream(scs) {
    var visible = scs.slice().reverse().filter(function (s) {
        return activeFilter === 'all' || s.status === activeFilter;
    });
    $('stream').innerHTML = visible.length ? visible.map(streamRow).join('') : emptyState('No scenarios match this filter.', 'i-chart');
}
function streamRow(s) {
    var st = statusClass(s.status || 'queued');
    return '<div class="stream-row">' +
        '<span class="status-chip ' + st + '">' + stateGlyph(st) + '</span>' +
        '<div class="stream-main"><div class="stream-name">' + esc(s.name) + '</div>' +
        '<div class="stream-meta">' + esc(fmtFeature(s.featureFile)) + '</div></div>' +
        '<span class="stream-state ' + st + '">' + st + '</span>' +
        '<span class="stream-time">' + (s.duration ? fmtDuration(s.duration) : st === 'running' ? 'live' : '—') + '</span></div>';
}

/* ---------------- render: queue ---------------- */
function renderQueue() {
    var rs = state.runStatus || { run: { status: 'idle', message: 'Ready to run' }, features: state.features };
    $('run-message').textContent = rs.run.message || 'Ready to run';

    var sel = selectedFile();
    var list = (rs.features || []).filter(function (f) { return !sel || f.uri === sel; });
    $('feature-status-list').innerHTML = list.length
        ? list.map(function (f) {
            var st = statusClass(f.status);
            return '<div class="queue-row">' +
                '<span class="status-dot ' + st + '"></span>' +
                '<div class="queue-name"><strong>' + esc(fmtFeature(f.uri)) + '</strong><small>' + esc(f.name) + '</small></div>' +
                '<span class="queue-status ' + st + '">' + st + '</span></div>';
        }).join('')
        : emptyState('No feature files detected.');
}

/* ---------------- render: reports ---------------- */
/* ---------------- report search: find a specific feature file, scenario or step ---------------- */
function queryMatches(text, query) {
    return !!query && String(text == null ? '' : text).toLowerCase().indexOf(query) !== -1;
}
// Wraps the first occurrence of `query` in a <mark>, escaping everything else — matching
// must happen on the raw string before escaping, since HTML-entity escaping (& -> &amp;)
// would otherwise shift the match offsets.
function highlightMatch(text, query) {
    var raw = String(text == null ? '' : text);
    if (!query) return esc(raw);
    var idx = raw.toLowerCase().indexOf(query);
    if (idx < 0) return esc(raw);
    return esc(raw.slice(0, idx)) + '<mark class="search-hit">' + esc(raw.slice(idx, idx + query.length)) + '</mark>' + esc(raw.slice(idx + query.length));
}
// Narrows the report down to features/scenarios that match the query (by feature name/path,
// background step, scenario name, or step text), and marks which feature/scenario keys should
// be force-expanded so the match is visible without the user having to click through.
function filterReportForQuery(features, rawQuery) {
    var query = String(rawQuery || '').trim().toLowerCase();
    if (!query) return { features: features, forceOpen: {}, matchCount: null };
    var forceOpen = {};
    var matchCount = 0;
    var filtered = features.map(function (feature) {
        var key = feature.uri;
        var featureLevelMatch = queryMatches(feature.name, query) || queryMatches(fmtFeature(feature.uri), query) ||
            ((feature.background && feature.background.steps) || []).some(function (step) {
                return queryMatches(step.name, query) || queryMatches(step.keyword, query);
            });
        var kept = [];
        (feature.elements || []).forEach(function (scenario) {
            var scenarioMatch = queryMatches(scenario.name, query);
            var stepMatch = (scenario.steps || []).some(function (step) {
                return queryMatches(step.name, query) || queryMatches(step.keyword, query);
            });
            if (featureLevelMatch || scenarioMatch || stepMatch) {
                if (scenarioMatch || stepMatch) forceOpen['s:' + key + ':' + kept.length] = true;
                kept.push(scenario);
            }
        });
        if (!kept.length && !featureLevelMatch) return null;
        matchCount += kept.length;
        forceOpen['f:' + key] = true;
        return Object.assign({}, feature, { elements: kept });
    }).filter(Boolean);
    return { features: filtered, forceOpen: forceOpen, matchCount: matchCount };
}

function renderReports() {
    var features = reportFeatures();
    var scs = features.reduce(function (a, f) { return a.concat(f.elements || []); }, []);
    var passed = scs.filter(function (s) { return scenarioStatus(s) === 'passed'; }).length;
    var failed = scs.filter(function (s) { return scenarioStatus(s) === 'failed'; }).length;
    var running = scs.filter(function (s) { return scenarioStatus(s) === 'running'; }).length;
    var waiting = scs.filter(function (s) { return scenarioStatus(s) === 'waiting'; }).length;
    var completed = passed + failed;
    var passRate = completed ? Math.round(passed / completed * 100) : 0;
    var duration = scs.reduce(function (t, s) { return t + scenarioDuration(s); }, 0);

    $('report-total').textContent = scs.length;
    $('report-pass-rate').textContent = completed ? passRate + '%' : '—';
    $('report-pass-copy').textContent = completed ? passed + ' of ' + completed + ' completed passed' : 'No completed scenarios';
    $('report-features').textContent = features.length;
    $('report-duration').textContent = fmtDuration(duration);

    var rs = state.runStatus || { run: { status: 'idle', startedAt: null } };
    $('report-run-status').textContent = String(rs.run.status || 'idle').toUpperCase();
    $('report-run-time').textContent = fmtTime(rs.run.startedAt);

    drawDonut([
        { value: passed, color: 'var(--pass)', label: 'Passed' },
        { value: failed, color: 'var(--fail)', label: 'Failed' },
        { value: running, color: 'var(--run)', label: 'Running' },
        { value: waiting, color: 'var(--queued)', label: 'Waiting' }
    ], passRate);

    // The search field narrows only the feature/scenario/step list below — the KPI
    // cards and donut above always reflect the full report.
    var query = reportQuery.trim().toLowerCase();
    var filteredResult = filterReportForQuery(features, query);
    var visibleFeatures = filteredResult.features;
    var forceOpen = filteredResult.forceOpen;

    var summaryEl = $('report-search-summary');
    if (query) {
        var scenarioWord = filteredResult.matchCount === 1 ? 'scenario' : 'scenarios';
        summaryEl.textContent = filteredResult.matchCount
            ? filteredResult.matchCount + ' matching ' + scenarioWord + ' across ' + visibleFeatures.length + ' feature file' + (visibleFeatures.length === 1 ? '' : 's')
            : 'No matches for "' + reportQuery.trim() + '"';
        summaryEl.classList.remove('hidden');
    } else {
        summaryEl.classList.add('hidden');
    }

    $('feature-report').innerHTML = visibleFeatures.length
        ? visibleFeatures.map(function (f) { return featureBlock(f, query, forceOpen); }).join('')
        : emptyState(query ? 'No feature, scenario, or step matched your search.' : 'No report data is available yet — run a scenario to populate this view.', 'i-chart');
}

function drawDonut(segments, passRate) {
    var total = segments.reduce(function (t, s) { return t + s.value; }, 0);
    var offset = 0;
    var rings = total
        ? segments.filter(function (s) { return s.value > 0; }).map(function (s) {
            var frac = s.value / total;
            var dash = frac * RING_C;
            var seg = '<circle class="donut-seg" cx="60" cy="60" r="' + RING_R + '" stroke="' + s.color +
                '" stroke-dasharray="' + dash + ' ' + (RING_C - dash) + '" stroke-dashoffset="' + (-offset) + '"></circle>';
            offset += dash;
            return seg;
        }).join('')
        : '<circle class="donut-seg" cx="60" cy="60" r="' + RING_R + '" stroke="#eef0f4" stroke-dasharray="' + RING_C + ' ' + RING_C + '"></circle>';
    $('donut').innerHTML = rings;

    $('donut-center').innerHTML = '<strong>' + (total ? passRate + '%' : '—') + '</strong><small>pass rate</small>';
    $('dist-legend').innerHTML = segments.map(function (s) {
        return '<div class="legend-row"><span class="swatch" style="background:' + s.color + '"></span><span>' + s.label + '</span><b>' + s.value + '</b></div>';
    }).join('');
}

function backgroundBlock(bg, keyPrefix, query) {
    if (!bg) return '';
    var steps = (bg.steps || []).map(function (s, i) { return stepRow(s, false, keyPrefix + ':bg:st' + i, query); }).join('');
    if (!steps && !bg.name) return '';
    var bgTitle = 'Background' + (bg.name ? ': ' + bg.name : '');
    return '<section class="scenario-block background-block">' +
        '<div class="scenario-head background-head">' +
        '<svg class="icon scenario-chevron"><use href="#i-list"/></svg>' +
        '<span class="scenario-state waiting">·</span>' +
        '<span class="scenario-copy"><span class="scenario-tags"></span>' +
        '<strong class="background-title">' + esc(bgTitle) + '</strong></span>' +
        '<span class="scenario-head-actions"><span class="background-badge">Runs before every scenario</span></span>' +
        '</div>' +
        '<div class="scenario-steps">' + (steps || '<div class="step-row"><span class="step-name">No steps recorded.</span></div>') + '</div>' +
        '</section>';
}

function featureBlock(feature, query, forceOpen) {
    var scs = feature.elements || [];
    var fp = scs.filter(function (s) { return scenarioStatus(s) === 'passed'; }).length;
    var ff = scs.filter(function (s) { return scenarioStatus(s) === 'failed'; }).length;
    var fr = scs.filter(function (s) { return scenarioStatus(s) === 'running'; }).length;
    var key = feature.uri;
    var isCollapsed = (forceOpen && forceOpen['f:' + key]) ? false : !!collapsed['f:' + key];
    var counts = '';
    if (fp) counts += '<span class="count-chip pass">' + fp + ' pass</span>';
    if (fr) counts += '<span class="count-chip run">' + fr + ' live</span>';
    if (ff) counts += '<span class="count-chip fail">' + ff + ' fail</span>';

    return '<article class="feature-block' + (isCollapsed ? ' collapsed' : '') + '">' +
        '<button class="feature-head" data-feature-key="' + esc(key) + '">' +
        '<svg class="icon feature-chevron"><use href="#i-chevron"/></svg>' +
        '<span class="feature-copy"><span class="feature-path">' + highlightMatch(fmtFeature(feature.uri), query) + '</span>' +
        '<strong>' + highlightMatch(feature.name || 'Unnamed feature', query) + '</strong>' +
        '<small>' + esc(feature.description || 'Feature execution details') + '</small></span>' +
        '<span class="feature-counts">' + counts + '</span></button>' +
        '<div class="feature-body">' + backgroundBlock(feature.background, key, query) +
            scs.map(function (s, i) { return scenarioBlock(s, key + ':' + i, feature.uri, query, forceOpen); }).join('') + '</div></article>';
}

function scenarioBlock(scenario, key, featureUri, query, forceOpen) {
    var st = scenarioStatus(scenario);
    var outline = isScenarioOutline(scenario);
    var isCollapsed = (forceOpen && forceOpen['s:' + key]) ? false : !!collapsed['s:' + key];
    var steps = (scenario.steps || []).map(function (s, i) { return stepRow(s, outline, key + ':st' + i, query); }).join('');
    var scenarioName = scenario.name || 'Unnamed scenario';
    var editBtn = featureUri && scenarioName
        ? '<button class="btn-icon scenario-edit-tags" data-edit-tags="' + esc(String(featureUri).replace(/"/g, '&quot;') + '::' + String(scenarioName).replace(/"/g, '&quot;')) + '" title="Edit tags">' + icon('i-edit') + '</button>'
        : '';
    var typeBadge = outline
        ? '<span class="scenario-type-badge outline-type">' + icon('i-table') + ' Scenario Outline</span>'
        : '<span class="scenario-type-badge">Scenario</span>';
    var examplesHtml = outline ? outlineTableHtml(scenario.examples || []) : '';
    var shotBadge = scenarioHasShots(scenario)
        ? '<span class="scenario-shot-badge" title="Screenshot captured for this scenario">' + icon('i-image') + '</span>'
        : '';

    return '<section class="scenario-block ' + st + (outline ? ' is-outline-block' : '') + (isCollapsed ? ' collapsed' : '') + '">' +
        '<button class="scenario-head" data-scenario-key="' + esc(key) + '">' +
        '<svg class="icon scenario-chevron"><use href="#i-chevron"/></svg>' +
        '<span class="scenario-state ' + st + '">' + stateGlyph(st) + '</span>' +
        '<span class="scenario-copy">' + typeBadge +
        '<span class="scenario-tags">' + esc(scenarioTags(scenario).join(' ')) + '</span>' +
        '<strong>' + (outline ? placeholderHighlightHtml(scenarioName) : highlightMatch(scenarioName, query)) + '</strong></span>' +
        '<span class="scenario-head-actions">' +
            shotBadge +
            editBtn +
            '<span class="scenario-duration">' + (scenarioDuration(scenario) ? fmtDuration(scenarioDuration(scenario)) : st === 'running' ? 'live' : '—') + '</span>' +
        '</span>' +
        '</button>' +
        '<div class="scenario-steps">' + (steps || '<div class="step-row"><span class="step-name">No steps recorded.</span></div>') + '</div>' +
        examplesHtml +
        '</section>';
}

function stepRow(step, isOutlineContext, stepKey, query) {
    var st = stepStatus(step);
    var durMs = stepDurationMs(step);
    var dur = durMs != null ? fmtDuration(durMs) : (st === 'running' ? 'live' : '—');
    var glyph = st === 'passed' ? icon('i-check') : st === 'failed' ? icon('i-x') : '<span class="dotmark">·</span>';
    var stepName = isOutlineContext ? placeholderHighlightHtml(step.name || '') : highlightMatch(step.name || '', query);
    var row = '<div class="step-row">' +
        '<span class="step-icon ' + st + '">' + glyph + '</span>' +
        '<span class="step-name"><span class="kw">' + esc(step.keyword || '') + '</span>' +
            (stepName || '<span class="step-name-empty">—</span>') + '</span>' +
        '<span class="step-duration">' + dur + '</span></div>';

    return '<div class="step-block">' + row + stepExtras(step, stepKey) + '</div>';
}

/* Renders the collapsible "Show error" / "Screenshot" disclosures below a step,
   mirroring the classic cucumber-html-reporter but styled to match this console. */
function stepExtras(step, stepKey) {
    var html = '';
    var errMsg = stepErrorMessage(step);
    if (errMsg) {
        var errOpen = !!openPanels['err:' + stepKey];
        html += '<div class="step-panel step-panel-error' + (errOpen ? ' open' : '') + '">' +
            '<button class="step-toggle step-toggle-error" data-step-toggle="err:' + esc(stepKey) + '">' +
                icon('i-alert') + '<span class="step-toggle-label">Show error</span>' +
                '<svg class="icon step-toggle-chevron"><use href="#i-chevron"/></svg>' +
            '</button>' +
            '<pre class="step-error">' + esc(errMsg) + '</pre>' +
        '</div>';
    }
    var images = stepImages(step);
    if (images.length) {
        var shotOpen = !!openPanels['shot:' + stepKey];
        var countLabel = images.length > 1 ? 'Screenshots (' + images.length + ')' : 'Screenshot';
        var thumbs = images.map(function (img, i) {
            var src = 'data:' + (img.mime_type || 'image/png') + ';base64,' + img.data;
            return '<img class="step-shot-thumb" src="' + src + '" alt="Step screenshot ' + (i + 1) + '" title="Click to enlarge">';
        }).join('');
        html += '<div class="step-panel step-panel-shot' + (shotOpen ? ' open' : '') + '">' +
            '<button class="step-toggle step-toggle-shot" data-step-toggle="shot:' + esc(stepKey) + '">' +
                icon('i-image') + '<span class="step-toggle-label">' + countLabel + '</span>' +
                '<svg class="icon step-toggle-chevron"><use href="#i-chevron"/></svg>' +
            '</button>' +
            '<div class="step-shot-body">' + thumbs + '</div>' +
        '</div>';
    }
    return html;
}

/* ---------------- render: selects & file list ---------------- */
function allKnownTags() {
    var seen = {};
    var sel = selectedFile();
    (state.features || []).forEach(function (feature) {
        if (sel && feature.uri !== sel) return;
        (feature.tags || []).forEach(function (t) { seen[t] = (seen[t] || 0) + 1; });
        (feature.elements || []).forEach(function (scenario) {
            (scenario.tags || []).forEach(function (t) { seen[t] = (seen[t] || 0) + 1; });
        });
    });
    return Object.keys(seen).sort().map(function (tag) { return { tag: tag, count: seen[tag] }; });
}
function buildFileTree(features) {
    var root = { name: '', path: '', folders: {}, files: [] };
    (features || []).forEach(function (f) {
        var parts = String(f.uri || '').split(/[\\/]/).filter(Boolean);
        if (parts[0] === 'features') parts.shift(); // "features" is the implicit root, shown in the Explorer header
        var fileName = parts.pop() || f.uri;
        var node = root;
        var pathAcc = '';
        parts.forEach(function (part) {
            pathAcc = pathAcc ? pathAcc + '/' + part : part;
            if (!node.folders[part]) node.folders[part] = { name: part, path: pathAcc, folders: {}, files: [] };
            node = node.folders[part];
        });
        node.files.push({ name: fileName, uri: f.uri, feature: f });
    });
    pendingFolders.forEach(function (folderPath) {
        var node = root;
        var pathAcc = '';
        String(folderPath || '').split('/').filter(Boolean).forEach(function (seg) {
            pathAcc = pathAcc ? pathAcc + '/' + seg : seg;
            if (!node.folders[seg]) node.folders[seg] = { name: seg, path: pathAcc, folders: {}, files: [] };
            node = node.folders[seg];
        });
    });
    return root;
}
function mergedStudioFeatures() {
    var real = state.features || [];
    Object.keys(unsavedFiles).forEach(function (u) {
        if (real.some(function (f) { return f.uri === u; })) delete unsavedFiles[u];
    });
    var extra = Object.keys(unsavedFiles).map(function (u) {
        return { uri: u, name: unsavedFiles[u].name, unsaved: true };
    });
    return real.concat(extra);
}
function renderCreateRow(depth) {
    var isFolder = pendingCreate.type === 'folder';
    return '<div class="tree-create-row" style="--depth:' + depth + '">' +
            '<span class="tree-icon">' + icon(isFolder ? 'i-folder' : 'i-file') + '</span>' +
            '<input type="text" class="tree-create-input" placeholder="' + (isFolder ? 'Folder name' : 'name.feature') + '" value="' + esc(pendingCreate.value) + '" spellcheck="false" autocomplete="off">' +
        '</div>' +
        (pendingCreate.error ? '<div class="tree-create-error" style="--depth:' + depth + '">' + esc(pendingCreate.error) + '</div>' : '');
}
function renderFileTree(node, depth, activeUri) {
    var html = '';
    if (pendingCreate && pendingCreate.parent === node.path) html += renderCreateRow(depth);
    var folderNames = Object.keys(node.folders).sort(function (a, b) { return a.localeCompare(b); });
    folderNames.forEach(function (name) {
        var folder = node.folders[name];
        var key = 'tree:' + folder.path;
        var isCollapsed = !!collapsed[key];
        html += '<div class="tree-folder' + (isCollapsed ? ' collapsed' : '') + '">' +
            // A plain div (not <button>) here — it hosts real <button> action icons inside it,
            // and a <button> cannot legally contain another <button> (browsers silently close
            // the outer one, which broke hover-reveal actions and left them undetectable/misplaced).
            '<div class="tree-row folder-row" data-folder-key="' + esc(key) + '" style="--depth:' + depth + '" role="button" tabindex="0">' +
                '<span class="tree-chevron">' + icon('i-chevron') + '</span>' +
                '<span class="tree-icon folder-icon">' + icon('i-folder') + '</span>' +
                '<span class="tree-label">' + esc(name) + '</span>' +
                '<span class="tree-row-actions">' +
                    '<button class="tree-action-btn" data-tree-new-file="' + esc(folder.path) + '" title="New File...">' + icon('i-file-plus') + '</button>' +
                    '<button class="tree-action-btn" data-tree-new-folder="' + esc(folder.path) + '" title="New Folder...">' + icon('i-folder-plus') + '</button>' +
                    '<button class="tree-action-btn tree-action-danger" data-delete-folder="' + esc(folder.path) + '" title="Delete folder">' + icon('i-trash') + '</button>' +
                '</span>' +
            '</div>' +
            '<div class="tree-children">' + renderFileTree(folder, depth + 1, activeUri) + '</div>' +
        '</div>';
    });
    var files = node.files.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    files.forEach(function (file) {
        var isActive = file.uri === activeUri;
        var isUnsaved = !!(file.feature && file.feature.unsaved);
        // A plain div (not <button>) — same reason as folder-row above: it now hosts a
        // nested delete <button>, and a <button> cannot legally contain another <button>.
        html += '<div class="tree-row file-item' + (isActive ? ' active' : '') + (isUnsaved ? ' unsaved' : '') + '" data-uri="' + esc(file.uri) + '" style="--depth:' + depth + '" role="button" tabindex="0"' +
                (isUnsaved ? ' title="Unsaved — click Save changes to write this file to disk"' : '') + '>' +
            '<span class="tree-icon file-icon">' + icon('i-file') + '</span>' +
            '<span class="tree-label">' + esc(file.name) + '</span>' +
            (isUnsaved ? '<span class="tree-unsaved-dot">&#9679;</span>' : '') +
            '<span class="tree-row-actions">' +
                '<button class="tree-action-btn tree-action-danger" data-delete-file="' + esc(file.uri) + '" title="Delete file">' + icon('i-trash') + '</button>' +
            '</span>' +
        '</div>';
    });
    return html;
}
function updateFileTree() {
    var list = $('studio-file-list');
    var activeUri = studioFeature && studioFeature.uri;
    var markup = renderFileTree(buildFileTree(mergedStudioFeatures()), 0, activeUri);
    if (list.innerHTML !== markup) list.innerHTML = markup;
    var input = list.querySelector('.tree-create-input');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}
function startCreate(type, parent) {
    if (parent) collapsed['tree:' + parent] = false;
    pendingCreate = { type: type, parent: parent || '', value: '', error: '' };
    updateFileTree();
}
function cancelPendingCreate() {
    pendingCreate = null;
    updateFileTree();
}
function confirmPendingCreate() {
    if (!pendingCreate) return;
    var raw = String(pendingCreate.value || '').trim();
    if (!raw) { cancelPendingCreate(); return; }
    var type = pendingCreate.type;
    var parent = pendingCreate.parent;

    if (type === 'folder') {
        var folderName = raw.replace(/[\\/]+/g, ' ').trim();
        if (!/^[A-Za-z0-9 _.-]+$/.test(folderName)) {
            pendingCreate.error = 'Folder names can only contain letters, numbers, spaces, - and _.';
            updateFileTree();
            return;
        }
        var folderPath = parent ? parent + '/' + folderName : folderName;
        if (pendingFolders.indexOf(folderPath) === -1) pendingFolders.push(folderPath);
        collapsed['tree:' + folderPath] = false;
        pendingCreate = null;
        updateFileTree();
        FB.fetch('/api/folder', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'features/' + folderPath })
        })
            .then(function (r) { return r.json().then(function (p) { if (!r.ok) throw new Error(p.message || 'Could not create folder.'); return p; }); })
            .then(function () { toast('Folder created · ' + folderPath, 'success'); })
            .catch(function (e) {
                pendingFolders = pendingFolders.filter(function (p) { return p !== folderPath; });
                updateFileTree();
                toast(e.message, 'error');
            });
        return;
    }

    var fileName = raw.replace(/[\\/]+/g, ' ').trim();
    if (!/\.feature$/i.test(fileName)) fileName += '.feature';
    if (!/^[A-Za-z0-9 _.-]+\.feature$/i.test(fileName)) {
        pendingCreate.error = 'File names can only contain letters, numbers, spaces, - and _.';
        updateFileTree();
        return;
    }
    var uri = 'features/' + (parent ? parent + '/' : '') + fileName;
    if ((state.features || []).some(function (f) { return f.uri === uri; }) || unsavedFiles[uri]) {
        pendingCreate.error = 'A file with this name already exists here.';
        updateFileTree();
        return;
    }
    var displayName = fileName.replace(/\.feature$/i, '');
    unsavedFiles[uri] = { name: displayName };
    studioFeature = {
        uri: uri, name: displayName, description: '', tags: [], background: null,
        elements: [{ keyword: 'Scenario', name: 'New scenario', tags: [], steps: [{ keyword: 'Given ', name: 'a starting condition' }] }]
    };
    studioOriginalUri = null;
    pendingCreate = null;
    renderStudio();
    updateFileTree();
    toast('New file ready · fill it in and click Save changes.', 'success');
}

function blankStudioFeature() {
    studioFeature = { uri: '', name: '', description: '', tags: [], background: null, elements: [] };
    studioOriginalUri = null;
    renderStudio();
}

function deleteStudioFile(uri) {
    if (!uri) return;
    var label = fmtFeature(uri);
    confirmStudioAction({
        title: 'Delete feature file?',
        message: 'Delete "' + label + '"? This permanently removes the file from disk and cannot be undone.',
        confirmLabel: 'Delete file'
    }).then(function (ok) {
        if (!ok) return;
        var wasActive = !!(studioFeature && studioFeature.uri === uri);
        FB.fetch('/api/feature?file=' + encodeURIComponent(uri), { method: 'DELETE' })
            .then(function (r) { return r.json().then(function (body) { if (!r.ok) throw new Error(body.message || 'Could not delete the file.'); return body; }); })
            .then(function () { return FB.fetch('/api/features?ts=' + Date.now()).then(function (r) { return r.json(); }); })
            .then(function (features) {
                delete unsavedFiles[uri];
                state.features = features;
                toast('Deleted ' + label, 'success');
                if (wasActive) {
                    var next = features[0];
                    if (next) loadStudioFeature(next.uri); else blankStudioFeature();
                }
                updateFileTree();
                load();
            })
            .catch(function (e) { toast(e.message, 'error'); });
    });
}

function deleteStudioFolder(folderPath) {
    if (!folderPath) return;
    var label = folderPath.split('/').pop();
    confirmStudioAction({
        title: 'Delete folder?',
        message: 'Delete folder "' + label + '" and everything inside it? This permanently removes it from disk and cannot be undone.',
        confirmLabel: 'Delete folder'
    }).then(function (ok) {
        if (!ok) return;
        var prefix = 'features/' + folderPath + '/';
        var wasActiveInside = !!(studioFeature && (studioFeature.uri === 'features/' + folderPath || String(studioFeature.uri || '').indexOf(prefix) === 0));
        FB.fetch('/api/folder?path=' + encodeURIComponent('features/' + folderPath), { method: 'DELETE' })
            .then(function (r) { return r.json().then(function (body) { if (!r.ok) throw new Error(body.message || 'Could not delete the folder.'); return body; }); })
            .then(function () { return FB.fetch('/api/features?ts=' + Date.now()).then(function (r) { return r.json(); }); })
            .then(function (features) {
                Object.keys(unsavedFiles).forEach(function (u) { if (u.indexOf(prefix) === 0) delete unsavedFiles[u]; });
                pendingFolders = pendingFolders.filter(function (p) { return p !== folderPath && p.indexOf(folderPath + '/') !== 0; });
                state.features = features;
                toast('Deleted folder ' + label, 'success');
                if (wasActiveInside) {
                    var next = features[0];
                    if (next) loadStudioFeature(next.uri); else blankStudioFeature();
                }
                updateFileTree();
                load();
            })
            .catch(function (e) { toast(e.message, 'error'); });
    });
}

/* ---------------- step definitions ---------------- */
// Client-side mirror of the server's compileStepPattern() in dashboard-server.js —
// kept in sync so the live preview shown while typing exactly matches what gets saved.
function compileStepPatternClient(template) {
    var placeholder = '"..."';
    var segments = String(template || '').trim().split(placeholder);
    var escaped = segments.map(function (segment) { return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    return { source: '^' + escaped.join('"([^"]*)"') + '$', paramCount: segments.length - 1 };
}

function stepDefFileGroups() {
    var byFile = {};
    (stepDefs.steps || []).forEach(function (step) {
        if (!byFile[step.file]) byFile[step.file] = [];
        byFile[step.file].push(step);
    });
    return (stepDefs.files || []).map(function (file) { return { file: file, steps: byFile[file] || [] }; });
}

// Explorer: files/folders only — no step content shown until a file is selected.
function renderStepDefsExplorer() {
    var groups = stepDefFileGroups();
    $('stepdef-file-list').innerHTML = groups.length
        ? groups.map(function (group) {
            var isSelected = group.file === selectedStepDefFile;
            return '<button class="stepdef-file-item' + (isSelected ? ' is-selected' : '') + '" type="button" data-stepdef-file="' + esc(group.file) + '">' +
                '<span class="stepdef-file-icon">' + icon('i-file') + '</span>' +
                '<span class="stepdef-file-name">' + esc(group.file) + '</span>' +
                '<span class="stepdef-file-count">' + group.steps.length + '</span>' +
            '</button>';
        }).join('')
        : emptyState('No step-definition files found yet.', 'i-code');
}

// A light, regex-based approximation of JS syntax highlighting (comments, strings, the
// step's regex literal, and a handful of keywords) — good enough for a read-only preview
// of a step's own source, not a general-purpose tokenizer.
function highlightStepSnippet(text) {
    var tokenPattern = /(\/\/[^\n]*)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\/(?:\\.|[^\\/\n])+\/[a-z]*)|(\bthis\.(?:Given|When|Then)\b)|(\b(?:this|async|function|await|return|var|let|const|new|if|else|for|while|throw|try|catch)\b)/g;
    var html = '';
    var lastIndex = 0;
    var match;
    while ((match = tokenPattern.exec(text))) {
        html += esc(text.slice(lastIndex, match.index));
        if (match[1]) html += '<span class="tok-comment">' + esc(match[1]) + '</span>';
        else if (match[2]) html += '<span class="tok-string">' + esc(match[2]) + '</span>';
        else if (match[3]) html += '<span class="tok-regex">' + esc(match[3]) + '</span>';
        else if (match[4]) html += '<span class="tok-call">' + esc(match[4]) + '</span>';
        else if (match[5]) html += '<span class="tok-kw">' + esc(match[5]) + '</span>';
        lastIndex = tokenPattern.lastIndex;
    }
    html += esc(text.slice(lastIndex));
    return html;
}

// Keeps the highlighted <pre> behind the (transparent-text) Implementation textarea in
// sync — both its content and its scroll position, so the colored code appears to be
// what's actually being typed rather than a decoration that could drift out of step.
function syncStepDefBodyHighlight() {
    var value = $('stepdef-body').value;
    // A trailing newline collapses to no visible last line in a <pre> unless something
    // follows it — append a space so the highlight pane's height always matches the
    // textarea's, even when the last line is blank.
    $('stepdef-body-highlight').querySelector('code').innerHTML = highlightStepSnippet(value) + ' ';
}
function syncStepDefBodyScroll() {
    var body = $('stepdef-body');
    var highlight = $('stepdef-body-highlight');
    highlight.scrollTop = body.scrollTop;
    highlight.scrollLeft = body.scrollLeft;
}
function setStepDefBody(text) {
    $('stepdef-body').value = text || '';
    syncStepDefBodyHighlight();
}

/* ---------------- step definitions: implementation autocomplete ----------------
   A lightweight, fixed list of common Puppeteer/helpers snippets — not a language
   server, just enough to save retyping the API calls this codebase uses constantly. */
var STEPDEF_SNIPPETS = [
    { name: 'page.click', hint: 'click an element', insert: "await page.click('SELECTOR');" },
    { name: 'page.type', hint: 'type into a field', insert: "await page.type('SELECTOR', 'TEXT');" },
    { name: 'page.evaluate', hint: 'run code in the browser', insert: "await page.evaluate(function () {\n    \n});" },
    { name: 'page.waitForSelector', hint: 'wait for an element', insert: "await page.waitForSelector('SELECTOR');" },
    { name: 'page.waitForFunction', hint: 'poll until a condition is true', insert: "await page.waitForFunction(function () {\n    return true;\n});" },
    { name: 'page.$$', hint: 'find all matching elements', insert: "await page.$$('SELECTOR');" },
    { name: 'page.$eval', hint: 'read/act on one element', insert: "await page.$eval('SELECTOR', function (el) {\n    \n});" },
    { name: 'page.goto', hint: 'navigate to a URL', insert: "await page.goto('URL');" },
    { name: 'page.waitForNavigation', hint: 'wait for a page navigation', insert: 'await page.waitForNavigation();' },
    { name: 'page.waitForTimeout', hint: 'pause for a fixed time (ms)', insert: 'await page.waitForTimeout(1000);' },
    { name: 'helpers.openPage', hint: 'open/reuse a browser tab', insert: 'return helpers.openPage(url);' },
    { name: 'helpers.waitForLinkText', hint: 'wait for link text to appear', insert: 'return helpers.waitForLinkText(text, false, 30);' },
    { name: 'throw new Error', hint: 'fail the step with a message', insert: "throw new Error('MESSAGE');" }
];
var stepDefAcMatches = [];
var stepDefAcIndex = -1;

// The identifier-ish text immediately before the caret (e.g. "page.wa" while typing
// "page.waitForSelector") — what we filter STEPDEF_SNIPPETS against.
function stepDefWordAtCaret(textarea) {
    var pos = textarea.selectionStart;
    var before = textarea.value.slice(0, pos);
    var match = /[\w.$]+$/.exec(before);
    return { word: match ? match[0] : '', start: match ? pos - match[0].length : pos, end: pos };
}

function hideStepDefAutocomplete() {
    stepDefAcMatches = [];
    stepDefAcIndex = -1;
    $('stepdef-autocomplete').classList.add('hidden');
}

function renderStepDefAutocomplete() {
    var host = $('stepdef-autocomplete');
    host.innerHTML = stepDefAcMatches.map(function (s, i) {
        return '<button type="button" class="stepdef-autocomplete-item' + (i === stepDefAcIndex ? ' is-active' : '') + '" data-ac-index="' + i + '">' +
            '<span class="ac-name">' + esc(s.name) + '</span><span class="ac-hint">' + esc(s.hint) + '</span></button>';
    }).join('');
    host.classList.remove('hidden');
}

function updateStepDefAutocomplete() {
    var textarea = $('stepdef-body');
    var current = stepDefWordAtCaret(textarea);
    if (current.word.length < 2) { hideStepDefAutocomplete(); return; }
    var needle = current.word.toLowerCase();
    stepDefAcMatches = STEPDEF_SNIPPETS.filter(function (s) { return s.name.toLowerCase().indexOf(needle) !== -1; }).slice(0, 8);
    stepDefAcIndex = stepDefAcMatches.length ? 0 : -1;
    if (!stepDefAcMatches.length) { hideStepDefAutocomplete(); return; }
    renderStepDefAutocomplete();
}

function applyStepDefSnippet(index) {
    var snippet = stepDefAcMatches[index];
    if (!snippet) return;
    var textarea = $('stepdef-body');
    var current = stepDefWordAtCaret(textarea);
    var value = textarea.value;
    var newValue = value.slice(0, current.start) + snippet.insert + value.slice(current.end);
    var caretPos = current.start + snippet.insert.length;
    setStepDefBody(newValue);
    textarea.focus();
    textarea.setSelectionRange(caretPos, caretPos);
    hideStepDefAutocomplete();
}

function stepDefCodeText(s) {
    var indentedBody = (s.body || '// TODO: implement this step').split('\n').map(function (line) { return '    ' + line; }).join('\n');
    return 'this.' + s.keyword + '(/' + s.source + '/' + (s.flags || '') + ', async function (' + (s.params || '') + ') {\n' + indentedBody + '\n});';
}

// Detail panel: the full, syntax-styled source of every step in the selected file —
// shown only once a file is selected, per the Explorer now being files/folders only.
function renderStepDefDetail() {
    var panel = $('stepdef-detail-panel');
    if (!selectedStepDefFile) { panel.classList.add('hidden'); return; }
    var group = stepDefFileGroups().find(function (g) { return g.file === selectedStepDefFile; });
    if (!group) { panel.classList.add('hidden'); selectedStepDefFile = null; return; }

    panel.classList.remove('hidden');
    $('stepdef-detail-filename').textContent = group.file;
    $('stepdef-detail-list').innerHTML = group.steps.length
        ? group.steps.map(function (s) {
            var isEditing = !!(editingStep && editingStep.file === group.file && editingStep.source === s.source && editingStep.flags === s.flags);
            return '<button class="stepdef-code-block' + (isEditing ? ' is-editing' : '') + '" type="button"' +
                ' data-stepdef-edit-file="' + esc(group.file) + '"' +
                ' data-stepdef-edit-source="' + esc(s.source) + '"' +
                ' data-stepdef-edit-flags="' + esc(s.flags) + '"' +
                ' data-stepdef-edit-keyword="' + esc(s.keyword) + '"' +
                ' data-stepdef-edit-pattern="' + esc(s.pattern) + '"' +
                ' data-stepdef-edit-body="' + esc(s.body) + '"' +
                ' title="Click to edit this step">' +
                '<pre>' + highlightStepSnippet(stepDefCodeText(s)) + '</pre>' +
            '</button>';
        }).join('')
        : '<p class="stepdef-code-empty">No steps found in this file.</p>';
}

function renderStepDefFileOptions() {
    var select = $('stepdef-file-select');
    var current = select.value;
    var opts = (stepDefs.files || []).map(function (f) { return '<option value="' + esc(f) + '">' + esc(f) + '</option>'; }).join('') +
        '<option value="__new__">+ New file&hellip;</option>';
    if (select.innerHTML !== opts) select.innerHTML = opts;
    if (current && Array.prototype.some.call(select.options, function (o) { return o.value === current; })) select.value = current;
    else if (stepDefs.files && stepDefs.files.length) select.value = stepDefs.files[0];
    $('stepdef-new-file-row').classList.toggle('hidden', select.value !== '__new__');
}

function updateStepDefPreview() {
    var template = $('stepdef-template').value;
    var compiled = compileStepPatternClient(template);
    $('stepdef-pattern-preview').textContent = template.trim() ? '/' + compiled.source + '/' : '—';
}

function loadStepDefs() {
    FB.fetch('/api/step-definitions?ts=' + Date.now())
        .then(function (r) {
            // A stale dashboard-server process (started before this API existed) 404s here
            // with a plain-text body, which would otherwise fail silently in the Explorer —
            // surface it there directly instead of only in the form's message line.
            if (!r.ok) throw new Error('Server returned ' + r.status + ' for /api/step-definitions — restart the dashboard server to pick up this feature.');
            return r.json();
        })
        .then(function (data) {
            stepDefs = { files: (data && data.files) || [], steps: (data && data.steps) || [] };
            stepDefsLoaded = true;
            // If the step being edited no longer exists (deleted/changed outside the
            // dashboard since it was opened), fall back to create mode rather than
            // silently keep pointing at a step that's no longer there.
            if (editingStep && !stepDefs.steps.some(function (s) { return s.file === editingStep.file && s.source === editingStep.source && s.flags === editingStep.flags; })) {
                cancelStepDefEdit();
            }
            renderStepDefFileOptions();
            renderStepDefsExplorer();
            renderStepDefDetail();
        })
        .catch(function (e) {
            $('stepdef-message').textContent = e.message || 'Could not load step definitions.';
            $('stepdef-message').className = 'studio-message error';
            $('stepdef-file-list').innerHTML = emptyState(e.message || 'Could not load step definitions.', 'i-alert');
        });
}

function setStepDefKeyword(keyword) {
    document.querySelectorAll('#stepdef-keyword .seg-btn').forEach(function (b) {
        var active = b.dataset.keyword === keyword;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

function startEditStep(block) {
    editingStep = { file: block.dataset.stepdefEditFile, source: block.dataset.stepdefEditSource, flags: block.dataset.stepdefEditFlags };
    selectedStepDefFile = block.dataset.stepdefEditFile;
    setStepDefKeyword(block.dataset.stepdefEditKeyword);
    var select = $('stepdef-file-select');
    select.value = block.dataset.stepdefEditFile;
    select.disabled = true;
    $('stepdef-new-file-row').classList.add('hidden');
    $('stepdef-template').value = block.dataset.stepdefEditPattern;
    setStepDefBody(block.dataset.stepdefEditBody);
    updateStepDefPreview();

    $('stepdef-edit-banner').textContent = 'Editing ' + block.dataset.stepdefEditKeyword + ' "' + block.dataset.stepdefEditPattern + '" in ' + block.dataset.stepdefEditFile;
    $('stepdef-edit-banner').classList.remove('hidden');
    $('cancel-stepdef-edit').classList.remove('hidden');
    $('create-stepdef').innerHTML = icon('i-check') + ' Update step definition';
    $('stepdef-message').textContent = '';
    $('stepdef-message').className = 'studio-message';

    renderStepDefsExplorer();
    renderStepDefDetail();
    $('stepdef-template').scrollIntoView({ block: 'center' });
}

function cancelStepDefEdit() {
    editingStep = null;
    $('stepdef-file-select').disabled = false;
    $('stepdef-edit-banner').classList.add('hidden');
    $('cancel-stepdef-edit').classList.add('hidden');
    $('create-stepdef').innerHTML = icon('i-check') + ' Create step definition';
    $('stepdef-template').value = '';
    setStepDefBody('');
    updateStepDefPreview();
    renderStepDefFileOptions();
    renderStepDefsExplorer();
    renderStepDefDetail();
}

function saveStepDefinition() {
    var keywordBtn = document.querySelector('#stepdef-keyword .seg-btn.active');
    var keyword = keywordBtn ? keywordBtn.dataset.keyword : 'Given';
    var template = $('stepdef-template').value.trim();
    var body = $('stepdef-body').value;
    var messageEl = $('stepdef-message');
    var isEditing = !!editingStep;
    var file = isEditing ? editingStep.file : ($('stepdef-file-select').value === '__new__' ? $('stepdef-new-file').value.trim() : $('stepdef-file-select').value);

    if (!template) { messageEl.textContent = 'Enter the step text first.'; messageEl.className = 'studio-message error'; return; }
    if (!file) { messageEl.textContent = 'Choose or name a target file.'; messageEl.className = 'studio-message error'; return; }

    messageEl.textContent = 'Saving…';
    messageEl.className = 'studio-message';
    var payload = { keyword: keyword, file: file, template: template, body: body };
    if (isEditing) { payload.originalSource = editingStep.source; payload.originalFlags = editingStep.flags; }
    FB.fetch('/api/step-definition', {
        method: isEditing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.message || ('Could not ' + (isEditing ? 'update' : 'create') + ' the step definition.')); return b; }); })
        .then(function (result) {
            toast((isEditing ? 'Updated step in ' : 'Step added to ') + result.file, 'success');
            messageEl.textContent = (isEditing ? 'Updated ' : 'Added ') + result.keyword + ' "' + result.pattern + '" in ' + result.file;
            messageEl.className = 'studio-message';
            if (isEditing) cancelStepDefEdit();
            else { $('stepdef-template').value = ''; setStepDefBody(''); updateStepDefPreview(); }
            loadStepDefs();
            loadStepSuggestions();
        })
        .catch(function (e) { messageEl.textContent = e.message; messageEl.className = 'studio-message error'; });
}

function renderSelects() {
    var sel = $('feature-select');
    var current = sel.value;
    var opts = '<option value="">All feature files</option>' + state.features.map(function (f) {
        return '<option value="' + esc(f.uri) + '">' + esc(fmtFeature(f.uri)) + '</option>';
    }).join('');
    if (sel.innerHTML !== opts) {
        sel.innerHTML = opts;
        if (Array.prototype.some.call(sel.options, function (o) { return o.value === current; })) sel.value = current;
    }

    var tagSel = $('tag-select');
    var tagCurrent = tagSel.value;
    var tagCounts = allKnownTags();
    var tagOpts = '<option value="">No tag filter' + (state.features.length && tagCounts.length === 0 ? ' (will run every scenario)' : '') + '</option>' +
        tagCounts.map(function (entry) {
            return '<option value="' + esc(entry.tag) + '">' + esc(entry.tag) + ' · ' + entry.count + ' scenario' + (entry.count === 1 ? '' : 's') + '</option>';
        }).join('');
    if (tagSel.innerHTML !== tagOpts) {
        tagSel.innerHTML = tagOpts;
        if (Array.prototype.some.call(tagSel.options, function (o) { return o.value === tagCurrent; })) tagSel.value = tagCurrent;
    }
    var currentTag = tagSel.value;
    $('run-tag-label').textContent = currentTag ? currentTag : (selectedFile() ? 'all in file' : 'all scenarios');

    if (!pendingCreate) updateFileTree();

    $('last-updated').textContent = 'Updated ' + fmtTime(new Date());
}

/* ---------------- tag editor ---------------- */
function tagChipsHtml(tagsArray) {
    var normalized = (tagsArray || []).map(normalizeTagUI).filter(Boolean);
    var unique = normalized.filter(function (t, i) { return normalized.indexOf(t) === i; });
    var chips = unique.map(function (tag) {
        return '<span class="tag-chip" data-tag="' + esc(tag) + '">' +
            '<span class="tag-chip-label">' + esc(tag) + '</span>' +
            '<button class="tag-chip-remove" type="button" title="Remove ' + esc(tag) + '" aria-label="Remove ' + esc(tag) + '">' + icon('i-x') + '</button>' +
            '</span>';
    }).join('');
    return chips;
}

function renderTagEditor(containerSelector, initialTags) {
    var host = typeof containerSelector === 'string' ? document.querySelector(containerSelector) : containerSelector;
    if (!host) return;
    var tags = Array.isArray(initialTags) ? initialTags : splitTags(String(initialTags || ''));
    var normalized = tags.map(normalizeTagUI).filter(Boolean);
    var unique = normalized.filter(function (t, i) { return normalized.indexOf(t) === i; });
    host.innerHTML =
        '<div class="tag-editor">' +
            tagChipsHtml(unique) +
            '<input type="text" class="tag-input" placeholder="Type tag then press Enter" autocomplete="off" spellcheck="false">' +
            '<input type="hidden" class="tag-store" value="' + esc(unique.join(' ')) + '">' +
        '</div>';
}

function tagsFromEditor(editorHost) {
    var store = editorHost.querySelector('.tag-store');
    return store ? splitTags(store.value) : [];
}

function syncTagStore(editor) {
    var store = editor.querySelector('.tag-store');
    if (!store) return;
    var tags = Array.prototype.map.call(editor.querySelectorAll('.tag-chip'), function (chip) {
        return chip.getAttribute('data-tag');
    }).filter(Boolean);
    store.value = tags.join(' ');
}

function addTagToEditor(editor, rawTag) {
    var tag = normalizeTagUI(rawTag);
    if (!tag) return false;
    var existing = editor.querySelectorAll('.tag-chip');
    for (var i = 0; i < existing.length; i++) {
        if (existing[i].getAttribute('data-tag') === tag) return false;
    }
    var chipWrap = document.createElement('template');
    chipWrap.innerHTML = '<span class="tag-chip" data-tag="' + esc(tag) + '">' +
        '<span class="tag-chip-label">' + esc(tag) + '</span>' +
        '<button class="tag-chip-remove" type="button" title="Remove ' + esc(tag) + '" aria-label="Remove ' + esc(tag) + '">' + icon('i-x') + '</button>' +
        '</span>';
    editor.insertBefore(chipWrap.content.firstChild, editor.querySelector('.tag-input'));
    syncTagStore(editor);
    return true;
}

/* ---------------- studio ---------------- */
function loadStudioFeature(uri) {
    if (!uri) return;
    $('studio-message').textContent = 'Loading…';
    $('studio-message').className = 'studio-message';
    FB.fetch('/api/feature?file=' + encodeURIComponent(uri))
        .then(function (r) { return r.json(); })
        .then(function (f) {
            if (f && f.message) throw new Error(f.message);
            studioFeature = f;
            studioOriginalUri = f.uri;
            renderStudio();
        })
        .catch(function (e) { $('studio-message').textContent = e.message; });
}

function renderStudio() {
    if (!studioFeature) return;
    $('studio-uri').value = studioFeature.uri || '';
    $('studio-name').value = studioFeature.name || '';
    $('studio-description').value = studioFeature.description || '';

    var backgroundCard = '';
    if (studioFeature.background) {
        backgroundCard = backgroundEditor(studioFeature.background);
    } else {
        backgroundCard =
            '<div id="studio-bg-placeholder" class="bg-placeholder">' +
                '<div class="bg-placeholder-text"><svg class="icon"><use href="#i-list"/></svg>This feature has no Background yet</div>' +
                '<button class="btn ghost" id="add-background">' + icon('i-plus') + ' Add Background</button>' +
            '</div>';
    }
    $('studio-background').innerHTML = backgroundCard;

    $('studio-scenarios').innerHTML = (studioFeature.elements || []).map(scenarioEditor).join('');
    $('studio-message').textContent = '';
    $('studio-message').className = 'studio-message';
    renderTagEditor('#studio-tags-host', studioFeature.tags || []);
    var scenarioEditors = document.querySelectorAll('.scenario-editor');
    scenarioEditors.forEach(function (ed, idx) {
        var scenario = (studioFeature.elements || [])[idx];
        var host = ed.querySelector('.scenario-tags-host');
        if (host && scenario) renderTagEditor(host, scenario.tags || []);
    });
    var addBg = $('add-background');
    if (addBg) addBg.addEventListener('click', function () {
        var feature = readStudioForm();
        feature.background = { keyword: 'Background', name: 'Shared setup', steps: [{ keyword: 'Given ', name: 'a precondition' }] };
        studioFeature = { uri: feature.uri, name: feature.name, description: feature.description, tags: feature.tags, background: feature.background, elements: feature.scenarios };
        renderStudio();
    });
}

var KEYWORDS = ['Given ', 'When ', 'Then ', 'And ', 'But '];

function commitFeatureEdit(feature) {
    studioFeature = {
        uri: feature.uri, name: feature.name, description: feature.description,
        tags: feature.tags, background: feature.background || null, elements: feature.scenarios
    };
    renderStudio();
}

function confirmStudioAction(options) {
    if (typeof options === 'string') options = { message: options };
    options = options || {};
    var overlay = $('confirm-overlay');
    if (!overlay) {
        return Promise.resolve(typeof window !== 'undefined' && window.confirm ?
            window.confirm(options.message || 'Are you sure you want to remove this item?') : true);
    }
    var titleEl = $('confirm-title');
    var messageEl = $('confirm-message');
    var okBtn = $('confirm-ok');
    var cancelBtn = $('confirm-cancel');
    titleEl.textContent = options.title || 'Are you sure?';
    messageEl.textContent = options.message || 'This action cannot be undone.';
    okBtn.textContent = options.confirmLabel || 'Delete';
    cancelBtn.textContent = options.cancelLabel || 'Cancel';
    overlay.classList.remove('hidden');

    return new Promise(function (resolve) {
        function cleanup(result) {
            overlay.classList.add('hidden');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('mousedown', onOverlayClick);
            document.removeEventListener('keydown', onKeydown);
            resolve(result);
        }
        function onOk() { cleanup(true); }
        function onCancel() { cleanup(false); }
        function onOverlayClick(e) { if (e.target === overlay) cleanup(false); }
        function onKeydown(e) {
            if (e.key === 'Escape') cleanup(false);
            else if (e.key === 'Enter') cleanup(true);
        }
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('mousedown', onOverlayClick);
        document.addEventListener('keydown', onKeydown);
        cancelBtn.focus();
    });
}

function safeText(value) {
    return String(value == null ? '' : value).trim();
}

function makeStep(keyword, text) {
    var finalKeyword = String(keyword || 'Given ').trim();
    if (['Given', 'When', 'Then', 'And', 'But', '*'].indexOf(finalKeyword) < 0) finalKeyword = 'Given';
    return { keyword: finalKeyword + ' ', name: safeText(text) || 'a new step' };
}

function placeholderHighlightHtml(stepText) {
    var s = esc(stepText || '');
    return s.replace(/&lt;([A-Za-z_][A-Za-z0-9_-]*)&gt;/g, function (match, name) {
        return '<span class="step-placeholder" title="Placeholder: ' + esc(name) + '">&lt;' + esc(name) + '&gt;</span>';
    });
}

function backgroundEditor(background) {
    var steps = (background.steps || []).map(function (step, i) { return stepRowEditorHtml(step, i); }).join('');
    return '<div class="background-editor" data-background="true">' +
        '<div class="background-editor-head">' +
            '<span class="bg-kicker">' + icon('i-list') + ' Background</span>' +
            '<input class="background-name" value="' + esc(background.name || '') + '" placeholder="Background title (optional)">' +
            '<button class="btn ghost danger" data-action="remove-background">Remove Background</button>' +
        '</div>' +
        '<div class="steps">' + steps + '</div>' +
        '<button class="btn ghost" data-action="add-bg-step">' + icon('i-plus') + ' Add Background step</button>' +
    '</div>';
}

function getOutlineViewMode(scenarioIndex) {
    var key = 'outlineView:' + scenarioIndex + ':' + (studioOriginalUri || studioFeature && studioFeature.uri || '');
    return collapsed[key] === 'individual' ? 'individual' : 'table';
}
function setOutlineViewMode(scenarioIndex, mode) {
    var key = 'outlineView:' + scenarioIndex + ':' + (studioOriginalUri || studioFeature && studioFeature.uri || '');
    collapsed[key] = mode;
}
function expandOutlineScenario(baseScenario, rowValues, headers, rowIdx) {
    var resolvedName = String(baseScenario.name || '');
    headers.forEach(function (h, hi) {
        resolvedName = resolvedName.split('<' + h + '>').join(rowValues[hi] || ('<row_' + rowIdx + '_' + hi + '>'));
    });
    var resolvedSteps = (baseScenario.steps || []).map(function (step) {
        var stepName = String(step.name || '');
        headers.forEach(function (h, hi) {
            stepName = stepName.split('<' + h + '>').join(rowValues[hi] || ('<row_' + rowIdx + '_' + hi + '>'));
        });
        return { keyword: step.keyword, name: stepName };
    });
    return { name: resolvedName, steps: resolvedSteps };
}
function individualScenariosHtml(baseScenario, ex, scenarioIndex, exIndex) {
    var headers = ex.header || [];
    var body = ex.body || [];
    if (!body.length) return '<div class="empty-state" style="padding:20px">' + icon('i-info') + '<span>No example rows yet — add rows in the Table view.</span></div>';
    return body.map(function (rowValues, rowIdx) {
        var expanded = expandOutlineScenario(baseScenario, rowValues, headers, rowIdx);
        var steps = expanded.steps.map(function (s, si) { return stepRowEditorHtml(s, scenarioIndex + '_' + exIndex + '_' + rowIdx + '_' + si, true); }).join('');
        return '<div class="expanded-example-row">' +
            '<div class="expanded-example-head"><span class="expanded-example-idx">Example #' + (rowIdx + 1) + '</span>' +
            '<strong class="expanded-example-name">' + esc(expanded.name) + '</strong></div>' +
            '<div class="steps" style="margin:10px 0 4px; padding-left:12px; border-left:2px solid var(--accent-soft)">' + steps + '</div>' +
            '</div>';
    }).join('');
}
function stepRowEditorHtml(step, stepIndex, readOnly) {
    var kw = String(step.keyword || 'Given ').trim();
    var options = KEYWORDS.map(function (k) {
        return '<option' + (kw === k.trim() ? ' selected' : '') + '>' + k + '</option>';
    }).join('');
    if (readOnly) {
        return '<div class="step-row-editor readonly-step" data-step="' + (stepIndex || 0) + '">' +
            '<select class="step-keyword" disabled>' + options + '</select>' +
            '<div class="step-name readonly-step-name">' + placeholderHighlightHtml(step.name || '') + '</div></div>';
    }
    return '<div class="step-row-editor" data-step="' + stepIndex + '">' +
        '<select class="step-keyword">' + options + '</select>' +
        '<input class="step-name" list="step-suggestions" autocomplete="off" value="' + esc(step.name || '') + '" placeholder="Step text — use &lt;ColumnName&gt; for placeholders">' +
        '<div class="step-row-actions">' +
            '<button class="icon-btn" data-action="insert-step-before" data-step="' + stepIndex + '" title="Insert step before">' + icon('i-plus') + '</button>' +
            '<button class="icon-btn" data-action="insert-step-after" data-step="' + stepIndex + '" title="Insert step after">' + icon('i-plus') + '</button>' +
            '<button class="icon-btn" data-action="remove-step" data-step="' + stepIndex + '" title="Remove step">' + icon('i-x') + '</button>' +
        '</div></div>';
}
function examplesTableEditorHtml(ex, scenarioIndex, exIndex) {
    var headers = ex.header && ex.header.length ? ex.header : ['Column1'];
    var body = ex.body && ex.body.length ? ex.body : [headers.map(function () { return ''; })];
    var theadCells = headers.map(function (h, ci) {
        return '<th><input class="ex-header-input" value="' + esc(h) + '" placeholder="Column name" ' +
            'data-ex-idx="' + exIndex + '" data-col="' + ci + '">' +
            '<button class="ex-col-remove icon-btn" data-action="remove-ex-column" data-ex-idx="' + exIndex + '" data-col="' + ci + '" title="Remove column">' + icon('i-x') + '</button></th>';
    }).join('') + '<th class="ex-thin-col"></th>';
    var bodyRows = body.map(function (row, ri) {
        var cells = headers.map(function (_, ci) {
            var val = (row && row[ci] != null) ? row[ci] : '';
            return '<td><input class="ex-cell-input" value="' + esc(val) + '" placeholder="value" ' +
                'data-ex-idx="' + exIndex + '" data-row="' + ri + '" data-col="' + ci + '"></td>';
        }).join('');
        return '<tr>' + cells + '<td class="ex-thin-col ex-row-actions">' +
            '<button class="icon-btn" data-action="remove-ex-row" data-ex-idx="' + exIndex + '" data-row="' + ri + '" title="Remove row">' + icon('i-x') + '</button></td></tr>';
    }).join('');
    return '<div class="examples-table-wrap">' +
        '<table class="examples-table">' +
        '<thead><tr>' + theadCells + '</tr></thead>' +
        '<tbody>' + bodyRows + '</tbody></table>' +
        '<div class="examples-toolbar">' +
        '<span class="examples-count-chip">' + icon('i-chart') + ' ' + body.length + ' row' + (body.length === 1 ? '' : 's') + ' · ' + headers.length + ' column' + (headers.length === 1 ? '' : 's') + '</span>' +
        '<div class="examples-toolbar-actions">' +
        '<button class="btn ghost" data-action="add-ex-column" data-ex-idx="' + exIndex + '">' + icon('i-plus') + ' Column</button>' +
        '<button class="btn ghost" data-action="add-ex-row" data-ex-idx="' + exIndex + '">' + icon('i-plus') + ' Row</button>' +
        '</div></div></div>';
}
function scenarioEditor(scenario, index) {
    var steps = (scenario.steps || []).map(function (step, i) { return stepRowEditorHtml(step, i); }).join('');
    var isOutline = scenario.isOutline === true || (Array.isArray(scenario.examples) && scenario.examples.length > 0);
    var keyword = (scenario.keyword || '').trim() || (isOutline ? 'Scenario Outline' : 'Scenario');

    var examplesHtml = '';
    if (isOutline) {
        var examplesArr = scenario.examples && scenario.examples.length ? scenario.examples : [{ keyword: 'Examples', name: '', tags: [], header: ['Column1'], body: [['']] }];
        var viewMode = getOutlineViewMode(index);
        examplesHtml = '<div class="outline-panel" data-outline="true">' +
            '<div class="outline-toolbar">' +
            '<div class="outline-kicker">' + icon('i-table') + ' Scenario Outline</div>' +
            '<div class="seg outline-view-seg">' +
            '<button class="seg-btn' + (viewMode === 'table' ? ' active' : '') + '" data-action="set-outline-view" data-scenario="' + index + '" data-view="table">' + icon('i-table') + ' Table</button>' +
            '<button class="seg-btn' + (viewMode === 'individual' ? ' active' : '') + '" data-action="set-outline-view" data-scenario="' + index + '" data-view="individual">' + icon('i-list') + ' Expanded</button>' +
            '</div>' +
            '<button class="btn ghost" data-action="toggle-outline" data-scenario="' + index + '">' + icon('i-x') + ' Convert to Scenario</button>' +
            '</div>' +
            '<div class="placeholder-hint">' + icon('i-info') + ' Use <code>&lt;ColumnName&gt;</code> placeholders in steps. Each row in the Examples table below will run as a separate scenario.</div>' +
            examplesArr.map(function (ex, exIndex) {
                var content;
                if (viewMode === 'individual') {
                    content = individualScenariosHtml(scenario, ex, index, exIndex);
                } else {
                    content = examplesTableEditorHtml(ex, index, exIndex);
                }
                return '<div class="examples-block" data-examples-idx="' + exIndex + '">' +
                    '<div class="examples-head">' +
                    '<input class="examples-keyword" value="' + esc(ex.keyword || 'Examples') + '" data-ex-idx="' + exIndex + '">' +
                    '<input class="examples-name" value="' + esc(ex.name || '') + '" placeholder="Examples name (optional)" data-ex-idx="' + exIndex + '">' +
                    '</div>' +
                    content +
                    '</div>';
            }).join('') +
            '</div>';
    } else {
        examplesHtml = '<div class="outline-empty-panel">' +
            '<button class="btn ghost" data-action="toggle-outline" data-scenario="' + index + '">' + icon('i-table') + ' Convert to Scenario Outline</button>' +
            '</div>';
    }

    return '<div class="scenario-editor' + (isOutline ? ' is-outline-editor' : '') + '" data-scenario="' + index + '">' +
        '<div class="scenario-editor-head outline-head-row">' +
        '<div class="scenario-name-wrap">' +
        '<span class="scenario-keyword-badge' + (isOutline ? ' outline-badge' : '') + '">' + esc(keyword) + '</span>' +
        '<input class="scenario-name" value="' + esc(scenario.name || '') + '" placeholder="' + (isOutline ? 'Outline name — use <ColumnName> for placeholders' : 'Scenario name') + '">' +
        '</div>' +
        '<div class="scenario-tags-host"></div>' +
        '<button class="btn ghost danger" data-action="remove-scenario">Remove</button></div>' +
        '<div class="steps">' + steps + '</div>' +
        '<button class="btn ghost" data-action="add-step">' + icon('i-plus') + ' Add step</button>' +
        examplesHtml +
        '</div>';
}

function splitTags(text) {
    return String(text || '').split(/[\s,;]+/).map(normalizeTagUI).filter(Boolean);
}

function readStudioForm() {
    var bgHost = document.querySelector('.background-editor');
    var background = null;
    if (bgHost) {
        var bgNameInput = bgHost.querySelector('.background-name');
        background = {
            keyword: 'Background',
            name: safeText(bgNameInput ? bgNameInput.value : ''),
            steps: Array.prototype.map.call(bgHost.querySelectorAll('.step-row-editor:not(.readonly-step)'), function (row) {
                var keywordEl = row.querySelector('.step-keyword');
                var nameEl = row.querySelector('.step-name');
                if (!keywordEl || !nameEl) return null;
                return { keyword: keywordEl.value, name: safeText(nameEl.value) };
            }).filter(Boolean)
        };
        if (!background.name && !background.steps.length) background = null;
    }
    var scenarios = Array.prototype.map.call(document.querySelectorAll('.scenario-editor'), function (card) {
        var isOutline = card.classList.contains('is-outline-editor') || !!card.querySelector('[data-outline="true"]');
        var tagHost = card.querySelector('.scenario-tags-host .tag-editor');
        var examples = [];
        if (isOutline) {
            examples = Array.prototype.map.call(card.querySelectorAll('.examples-block'), function (exBlock) {
                var exIdx = Number(exBlock.dataset.examplesIdx || 0);
                var headerInputs = exBlock.querySelectorAll('.ex-header-input');
                var headers = Array.prototype.map.call(headerInputs, function (inp) { return (inp.value || '').trim(); }).filter(function (_, i) {
                    return i === 0 || (headerInputs[i - 1] && headerInputs[i - 1].value && headerInputs[i - 1].value.trim() !== '') || (inp.value && inp.value.trim() !== '');
                });
                if (!headers.length) headers = ['Column1'];
                var rowCount = 0;
                exBlock.querySelectorAll('.ex-cell-input').forEach(function (inp) {
                    var r = Number(inp.dataset.row || 0);
                    if (r + 1 > rowCount) rowCount = r + 1;
                });
                if (!rowCount) rowCount = 1;
                var body = [];
                for (var ri = 0; ri < rowCount; ri++) {
                    var row = [];
                    for (var ci = 0; ci < headers.length; ci++) {
                        var cellInput = exBlock.querySelector('.ex-cell-input[data-ex-idx="' + exIdx + '"][data-row="' + ri + '"][data-col="' + ci + '"]');
                        row.push(cellInput ? cellInput.value : '');
                    }
                    body.push(row);
                }
                var kwInput = exBlock.querySelector('.examples-keyword');
                var nmInput = exBlock.querySelector('.examples-name');
                return {
                    keyword: safeText(kwInput ? kwInput.value : 'Examples') || 'Examples',
                    name: safeText(nmInput ? nmInput.value : ''),
                    tags: [],
                    header: headers,
                    body: body
                };
            });
            if (!examples.length) {
                examples = [{ keyword: 'Examples', name: '', tags: [], header: ['Column1'], body: [['']] }];
            }
        }
        var scenarioNameInput = card.querySelector('.scenario-name');
        return {
            keyword: isOutline ? 'Scenario Outline' : 'Scenario',
            name: safeText(scenarioNameInput ? scenarioNameInput.value : ''),
            tags: tagHost ? tagsFromEditor(tagHost) : splitTags(card.querySelector('.scenario-tags') && card.querySelector('.scenario-tags').value || ''),
            isOutline: isOutline,
            examples: examples,
            steps: Array.prototype.map.call(card.querySelectorAll('.steps > .step-row-editor:not(.readonly-step)'), function (row) {
                var keywordEl = row.querySelector('.step-keyword');
                var nameEl = row.querySelector('.step-name');
                if (!keywordEl || !nameEl) return null;
                return { keyword: keywordEl.value, name: safeText(nameEl.value) };
            }).filter(Boolean)
        };
    });
    var uri = $('studio-uri').value.trim();
    var featureTagEditor = document.querySelector('#studio-tags-host .tag-editor');
    return {
        uri: uri,
        newUri: (studioOriginalUri && studioOriginalUri !== uri) ? uri : undefined,
        name: $('studio-name').value.trim(),
        tags: featureTagEditor ? tagsFromEditor(featureTagEditor) : splitTags($('studio-tags').value || ''),
        description: $('studio-description').value.trim(),
        background: background,
        scenarios: scenarios
    };
}

function saveStudioFeature() {
    var feature = readStudioForm();
    if (!feature.uri || !feature.name) {
        $('studio-message').textContent = 'File path and feature name are required.';
        $('studio-message').className = 'studio-message error';
        return;
    }
    $('studio-message').textContent = 'Saving…';
    $('studio-message').className = 'studio-message';
    FB.fetch('/api/feature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feature)
    })
        .then(function (r) {
            return r.json().then(function (p) { if (!r.ok) throw new Error(p.message || 'Save failed'); return p; });
        })
        .then(function (saved) {
            studioFeature = saved;
            studioOriginalUri = saved.uri;
            renderStudio();
            toast('Feature saved · ' + fmtFeature(saved.uri), 'success');
            load();
            loadStepSuggestions();
        })
        .catch(function (e) {
            $('studio-message').textContent = e.message;
            $('studio-message').className = 'studio-message error';
            toast(e.message, 'error');
        });
}

/* ---------------- actions ---------------- */
function currentMode() {
    var active = document.querySelector('#browser-mode .seg-btn.active');
    return active ? (active.dataset.mode || 'headless') : 'headless';
}

function startRun(kind) {
    var file = $('feature-select').value;
    var mode = currentMode();
    // 'kind' may be:
    //   - undefined / '' → run the currently-selected tag in <tag-select>
    //       (if no tag selected + no file → run all scenarios in all files via no-tag with no file is invalid,
    //        but server accepts only specific file-no-tag, so we treat no-tag+no-file as error client-side)
    //   - a specific tag string (e.g. '@feat' or '@batch') → use that tag
    var overrideTag = kind ? normalizeTagUI(kind) : '';
    var selectedTag = $('tag-select').value;
    var tag = overrideTag || selectedTag;
    if (overrideTag) {
        // Sync the selector UI so the primary button shows what's actually running
        var tagSel = $('tag-select');
        if (Array.prototype.some.call(tagSel.options, function (o) { return o.value === overrideTag; })) {
            tagSel.value = overrideTag;
        }
    }

    var labelBits = [];
    if (tag) labelBits.push(tag);
    if (file) labelBits.push(fmtFeature(file));
    if (!file && !tag) labelBits.push('all scenarios');
    var label = labelBits.join(' · ');

    $('run-message').textContent = 'Starting ' + label + '…';

    if (!file && !tag) {
        toast('Pick a feature file or a tag filter to run.', 'error');
        $('run-message').textContent = 'Pick a feature file or a tag filter.';
        return;
    }

    // re-check the environment at click time — never trust a stale headlessOnly flag
    FB.fetch('/api/env?ts=' + Date.now())
        .then(function (r) { return r.json(); })
        .catch(function () { return null; })
        .then(function (env) {
            if (env) state.env = env;
            var headlessOnly = !!state.env.headlessOnly;
            var headless = mode === 'headless' || headlessOnly;
            if (mode === 'windowed' && headlessOnly) {
                toast('Headed mode needs a desktop — this server has no display, so it will run headless.', 'error');
            }
            return FB.fetch('/api/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: tag, featureFile: file, headless: headless })
            });
        })
        .then(function (r) {
            return r.json().then(function (p) { if (!r.ok) throw new Error(p.message || 'Could not start run'); return p; });
        })
        .then(function (run) {
            $('run-message').textContent = run.message || ('Running ' + label);
            toast('Run started · ' + label + (run.headless === false ? ' (windowed)' : ''), 'success');
            load();
        })
        .catch(function (e) {
            $('run-message').textContent = e.message;
            toast(e.message, 'error');
        });
}

function stopRun() {
    $('stop-run').disabled = true;
    FB.fetch('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        .then(function (r) {
            return r.json().then(function (p) { if (!r.ok) throw new Error(p.message || 'Could not stop run'); return p; });
        })
        .then(function (p) { toast(p.message || 'Run stopped.', 'success'); load(); })
        .catch(function (e) { toast(e.message, 'error'); })
        .then(function () { $('stop-run').disabled = false; });
}

function toast(message, kind) {
    var host = $('toast-host');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
        el.classList.remove('show');
        setTimeout(function () { el.remove(); }, 300);
    }, 3200);
}

function switchView(view) {
    ['overview', 'reports', 'studio', 'stepdefs'].forEach(function (v) {
        $('view-' + v).classList.toggle('hidden', v !== view);
    });
    document.querySelectorAll('.tab').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    if (view === 'studio' && !studioFeature && state.features.length) loadStudioFeature(state.features[0].uri);
    if (view === 'stepdefs') loadStepDefs();
    if (view === 'studio' || view === 'stepdefs') requestAnimationFrame(syncStickyOffsets);
    syncLiveWatch();
}

/* ---------------- data loading ---------------- */
function loadStepSuggestions() {
    FB.fetch('/api/step-suggestions?ts=' + Date.now())
        .then(function (r) { return r.json(); })
        .then(function (suggestions) {
            state.stepSuggestions = Array.isArray(suggestions) ? suggestions : [];
            var list = $('step-suggestions');
            if (!list) return;
            list.innerHTML = state.stepSuggestions.map(function (s) {
                return '<option value="' + esc(s.text) + '"></option>';
            }).join('');
        })
        .catch(function () {});
}

function load() {
    Promise.all([
        FB.fetch('/api/progress?ts=' + Date.now()).then(function (r) { return r.json(); }),
        FB.fetch('/api/report?ts=' + Date.now()).then(function (r) { return r.json(); }),
        FB.fetch('/api/features?ts=' + Date.now()).then(function (r) { return r.json(); }),
        FB.fetch('/api/run-status?ts=' + Date.now()).then(function (r) { return r.json(); }),
        FB.fetch('/api/env?ts=' + Date.now()).then(function (r) { return r.json(); })
    ])
        .then(function (data) {
            state.progress = data[0];
            state.report = data[1];
            state.features = data[2];
            state.runStatus = data[3];
            state.env = data[4] || state.env;
            render();
        })
        .catch(function () { render(); });
}

/* ---------------- event wiring ---------------- */
document.addEventListener('click', function (event) {
    var removeChip = event.target.closest('.tag-chip-remove');
    if (removeChip) {
        var chip = removeChip.closest('.tag-chip');
        var editor = chip && chip.closest('.tag-editor');
        if (chip && editor) {
            chip.remove();
            syncTagStore(editor);
        }
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    var editTagsBtn = event.target.closest('[data-edit-tags]');
    if (editTagsBtn) {
        event.preventDefault();
        event.stopPropagation();
        var parts = String(editTagsBtn.dataset.editTags || '').split('::');
        var featureUri = parts[0];
        var scenarioName = parts.slice(1).join('::');
        openInlineTagEditor(featureUri, scenarioName, editTagsBtn);
        return;
    }

    var inlineCancel = event.target.closest('[data-inline-cancel]');
    if (inlineCancel) {
        event.preventDefault();
        event.stopPropagation();
        closeInlineTagEditors();
        return;
    }

    var inlineSave = event.target.closest('[data-inline-save]');
    if (inlineSave) {
        event.preventDefault();
        event.stopPropagation();
        saveInlineTagEditor(inlineSave);
        return;
    }

    var tab = event.target.closest('.tab');
    if (tab) { switchView(tab.dataset.view); return; }

    var filter = event.target.closest('.filter');
    if (filter) {
        document.querySelectorAll('.filter').forEach(function (f) { f.classList.remove('active'); });
        filter.classList.add('active');
        activeFilter = filter.dataset.filter;
        render();
        return;
    }

    var seg = event.target.closest('.seg-btn');
    if (seg) {
        // Scoped to the clicked button's own .seg group — this page now has more than
        // one independent segmented control (browser mode, step keyword picker), and an
        // unscoped query would deactivate every other group's selection too.
        var segGroup = seg.closest('.seg');
        (segGroup ? segGroup.querySelectorAll('.seg-btn') : document.querySelectorAll('.seg-btn')).forEach(function (b) {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
        });
        seg.classList.add('active');
        seg.setAttribute('aria-selected', 'true');
        if (segGroup && segGroup.id === 'browser-mode') renderModeHint();
        return;
    }

    var stepToggle = event.target.closest('[data-step-toggle]');
    if (stepToggle) {
        event.preventDefault();
        event.stopPropagation();
        var toggleKey = stepToggle.dataset.stepToggle;
        var isOpen = !openPanels[toggleKey];
        openPanels[toggleKey] = isOpen;
        var panel = stepToggle.closest('.step-panel');
        if (panel) panel.classList.toggle('open', isOpen);
        return;
    }

    var shotThumb = event.target.closest('.step-shot-thumb');
    if (shotThumb) {
        event.preventDefault();
        openLightbox(shotThumb.getAttribute('src'));
        return;
    }

    var featureHead = event.target.closest('.feature-head');
    if (featureHead) {
        var fk = featureHead.dataset.featureKey;
        collapsed['f:' + fk] = !collapsed['f:' + fk];
        featureHead.parentElement.classList.toggle('collapsed', collapsed['f:' + fk]);
        return;
    }

    var scenarioHead = event.target.closest('.scenario-head');
    if (scenarioHead && !event.target.closest('[data-edit-tags]')) {
        var sk = scenarioHead.dataset.scenarioKey;
        collapsed['s:' + sk] = !collapsed['s:' + sk];
        scenarioHead.parentElement.classList.toggle('collapsed', collapsed['s:' + sk]);
        return;
    }

    var treeNewFileBtn = event.target.closest('[data-tree-new-file]');
    if (treeNewFileBtn) {
        event.preventDefault();
        event.stopPropagation();
        startCreate('file', treeNewFileBtn.dataset.treeNewFile);
        return;
    }

    var treeNewFolderBtn = event.target.closest('[data-tree-new-folder]');
    if (treeNewFolderBtn) {
        event.preventDefault();
        event.stopPropagation();
        startCreate('folder', treeNewFolderBtn.dataset.treeNewFolder);
        return;
    }

    var deleteFileBtn = event.target.closest('[data-delete-file]');
    if (deleteFileBtn) {
        event.preventDefault();
        event.stopPropagation();
        deleteStudioFile(deleteFileBtn.dataset.deleteFile);
        return;
    }

    var deleteFolderBtn = event.target.closest('[data-delete-folder]');
    if (deleteFolderBtn) {
        event.preventDefault();
        event.stopPropagation();
        deleteStudioFolder(deleteFolderBtn.dataset.deleteFolder);
        return;
    }

    var folderRow = event.target.closest('.folder-row');
    if (folderRow) {
        var tk = folderRow.dataset.folderKey;
        collapsed[tk] = !collapsed[tk];
        folderRow.closest('.tree-folder').classList.toggle('collapsed', collapsed[tk]);
        return;
    }

    var fileItem = event.target.closest('.file-item');
    if (fileItem) { loadStudioFeature(fileItem.dataset.uri); return; }

    var action = event.target.closest('[data-action]');
    if (action && (action.closest('#studio-scenarios') || action.closest('#studio-background'))) {
        var scenario = action.closest('.scenario-editor');
        var bgEditor = action.closest('.background-editor');
        var feature = readStudioForm();

        if (action.dataset.action === 'set-outline-view') {
            setOutlineViewMode(Number(action.dataset.scenario || 0), action.dataset.view || 'table');
            studioFeature = { uri: feature.uri, name: feature.name, description: feature.description, tags: feature.tags, background: feature.background || null, elements: feature.scenarios };
            renderStudio();
            return;
        }

        if (action.dataset.action === 'toggle-outline') {
            var si = Number(action.dataset.scenario || 0);
            if (feature.scenarios[si]) {
                if (feature.scenarios[si].isOutline) {
                    feature.scenarios[si].isOutline = false;
                    feature.scenarios[si].examples = [];
                    feature.scenarios[si].keyword = 'Scenario';
                } else {
                    feature.scenarios[si].isOutline = true;
                    feature.scenarios[si].keyword = 'Scenario Outline';
                    feature.scenarios[si].examples = [{ keyword: 'Examples', name: '', tags: [], header: ['Column1'], body: [['']] }];
                }
            }
            studioFeature = { uri: feature.uri, name: feature.name, description: feature.description, tags: feature.tags, background: feature.background || null, elements: feature.scenarios };
            renderStudio();
            return;
        }

        if (scenario && (action.dataset.action === 'add-ex-column' || action.dataset.action === 'remove-ex-column' ||
            action.dataset.action === 'add-ex-row' || action.dataset.action === 'remove-ex-row')) {
            var si2 = Number(scenario.dataset.scenario || 0);
            var exIdx2 = Number(action.dataset.exIdx || 0);
            var col2 = Number(action.dataset.col);
            var row2 = Number(action.dataset.row);
            if (feature.scenarios[si2] && feature.scenarios[si2].examples && feature.scenarios[si2].examples[exIdx2]) {
                var ex2 = feature.scenarios[si2].examples[exIdx2];
                if (!ex2.header || !ex2.header.length) ex2.header = ['Column1'];
                if (!ex2.body) ex2.body = [ex2.header.map(function () { return ''; })];
                if (action.dataset.action === 'add-ex-column') {
                    var newColName = 'Column' + (ex2.header.length + 1);
                    ex2.header.push(newColName);
                    ex2.body.forEach(function (r) { r.push(''); });
                } else if (action.dataset.action === 'remove-ex-column') {
                    if (ex2.header.length > 1) {
                        ex2.header.splice(col2, 1);
                        ex2.body.forEach(function (r) { r.splice(col2, 1); });
                    }
                } else if (action.dataset.action === 'add-ex-row') {
                    ex2.body.push(ex2.header.map(function () { return ''; }));
                } else if (action.dataset.action === 'remove-ex-row') {
                    if (ex2.body.length > 1) {
                        ex2.body.splice(row2, 1);
                    }
                }
            }
            studioFeature = { uri: feature.uri, name: feature.name, description: feature.description, tags: feature.tags, background: feature.background || null, elements: feature.scenarios };
            renderStudio();
            return;
        }

        if (bgEditor && !scenario) {
            if (action.dataset.action === 'remove-background') {
                confirmStudioAction({ title: 'Remove background?', message: 'Are you sure you want to remove this background?', confirmLabel: 'Remove' }).then(function (ok) {
                    if (!ok) return;
                    feature.background = null;
                    commitFeatureEdit(feature);
                });
                return;
            } else if (action.dataset.action === 'add-bg-step') {
                if (!feature.background) feature.background = { keyword: 'Background', name: '', steps: [] };
                feature.background.steps.push(makeStep('Given ', 'a new step'));
            } else if (action.dataset.action === 'insert-step-before' || action.dataset.action === 'insert-step-after') {
                if (!feature.background) feature.background = { keyword: 'Background', name: '', steps: [] };
                var bgPos = Number(action.dataset.step || 0);
                var bgInsertAt = action.dataset.action === 'insert-step-before' ? bgPos : bgPos + 1;
                feature.background.steps.splice(bgInsertAt, 0, makeStep('Given ', 'a new step'));
            } else if (action.dataset.action === 'remove-step') {
                var bgRow = action.closest('.step-row-editor');
                if (feature.background && feature.background.steps) {
                    confirmStudioAction({ title: 'Remove step?', message: 'Are you sure you want to remove this step?', confirmLabel: 'Remove' }).then(function (ok) {
                        if (!ok) return;
                        feature.background.steps.splice(Number(bgRow.dataset.step), 1);
                        if (!feature.background.name && !feature.background.steps.length) feature.background = null;
                        commitFeatureEdit(feature);
                    });
                    return;
                }
            }
        } else if (scenario) {
            var si = Number(scenario.dataset.scenario);
            if (action.dataset.action === 'remove-scenario') {
                confirmStudioAction({ title: 'Remove scenario?', message: 'Are you sure you want to remove this scenario?', confirmLabel: 'Remove' }).then(function (ok) {
                    if (!ok) return;
                    feature.scenarios.splice(si, 1);
                    commitFeatureEdit(feature);
                });
                return;
            } else if (action.dataset.action === 'add-step') {
                if (!feature.scenarios[si]) return;
                feature.scenarios[si].steps.push(makeStep('Given ', 'a new step'));
            } else if (action.dataset.action === 'insert-step-before' || action.dataset.action === 'insert-step-after') {
                if (!feature.scenarios[si]) return;
                var stepIndex = Number(action.dataset.step || 0);
                var insertAt = action.dataset.action === 'insert-step-before' ? stepIndex : stepIndex + 1;
                feature.scenarios[si].steps.splice(insertAt, 0, makeStep('Given ', 'a new step'));
            } else if (action.dataset.action === 'remove-step') {
                var row = action.closest('.step-row-editor');
                if (feature.scenarios[si] && feature.scenarios[si].steps) {
                    confirmStudioAction({ title: 'Remove step?', message: 'Are you sure you want to remove this step?', confirmLabel: 'Remove' }).then(function (ok) {
                        if (!ok) return;
                        feature.scenarios[si].steps.splice(Number(row.dataset.step), 1);
                        commitFeatureEdit(feature);
                    });
                    return;
                }
            }
        }

        commitFeatureEdit(feature);
    }
});

document.addEventListener('keydown', function (event) {
    var tagInput = event.target.closest('.tag-input');
    if (tagInput && event.key === 'Enter') {
        event.preventDefault();
        var editor = tagInput.closest('.tag-editor');
        var raw = tagInput.value.trim();
        if (!raw) return;
        if (addTagToEditor(editor, raw)) {
            tagInput.value = '';
        } else {
            tagInput.classList.add('input-shake');
            setTimeout(function () { tagInput.classList.remove('input-shake'); }, 400);
        }
        tagInput.focus();
    }
});

/* ---------------- inline tag editor (reports view) ---------------- */
function closeInlineTagEditors() {
    document.querySelectorAll('.inline-tags-panel').forEach(function (p) { p.remove(); });
}

function openInlineTagEditor(featureUri, scenarioName, anchorEl) {
    closeInlineTagEditors();
    if (!featureUri || !scenarioName) {
        toast('Cannot edit tags — scenario context missing.', 'error');
        return;
    }
    FB.fetch('/api/feature?file=' + encodeURIComponent(featureUri))
        .then(function (r) { return r.json(); })
        .then(function (f) {
            if (f && f.message) throw new Error(f.message);
            var sc = (f.elements || []).find(function (e) { return e.name === scenarioName; });
            if (!sc) throw new Error('Scenario not found in feature file.');
            var panel = document.createElement('div');
            panel.className = 'inline-tags-panel';
            panel.innerHTML =
                '<div class="inline-tags-head">' +
                    '<strong>' + icon('i-edit') + ' Edit tags</strong>' +
                    '<span class="inline-tags-sub">' + esc(fmtFeature(featureUri)) + ' · ' + esc(scenarioName) + '</span>' +
                '</div>' +
                '<div class="inline-tags-editor-host"></div>' +
                '<div class="inline-tags-actions">' +
                    '<button class="btn ghost" data-inline-cancel>Cancel</button>' +
                    '<button class="btn btn-primary" data-inline-save>' + icon('i-check') + ' Save tags</button>' +
                '</div>';
            panel.dataset.featureUri = f.uri;
            panel.dataset.scenarioName = scenarioName;
            var block = anchorEl.closest('.scenario-block');
            (block || document.body).appendChild(panel);
            renderTagEditor(panel.querySelector('.inline-tags-editor-host'), sc.tags || []);
        })
        .catch(function (e) { toast(e.message, 'error'); });
}

function saveInlineTagEditor(saveBtn) {
    var panel = saveBtn.closest('.inline-tags-panel');
    if (!panel) return;
    var featureUri = panel.dataset.featureUri;
    var scenarioName = panel.dataset.scenarioName;
    var tagEditor = panel.querySelector('.tag-editor');
    var newTags = tagsFromEditor(tagEditor);
    saveBtn.disabled = true;
    FB.fetch('/api/feature?file=' + encodeURIComponent(featureUri))
        .then(function (r) { return r.json(); })
        .then(function (f) {
            if (f && f.message) throw new Error(f.message);
            var found = false;
            f.elements = (f.elements || []).map(function (e) {
                if (e.name === scenarioName) { found = true; return Object.assign({}, e, { tags: newTags }); }
                return e;
            });
            if (!found) throw new Error('Scenario no longer exists in feature file.');
            return FB.fetch('/api/feature', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uri: f.uri,
                    name: f.name,
                    tags: f.tags || [],
                    description: f.description || '',
                    background: f.background || null,
                    scenarios: f.elements.map(function (e) {
                        return {
                            name: e.name,
                            tags: e.tags || [],
                            steps: e.steps || [],
                            keyword: e.keyword || (e.isOutline ? 'Scenario Outline' : 'Scenario'),
                            isOutline: e.isOutline === true,
                            examples: e.examples || []
                        };
                    })
                })
            }).then(function (r) {
                return r.json().then(function (p) { if (!r.ok) throw new Error(p.message || 'Save failed'); return p; });
            });
        })
        .then(function () {
            toast('Tags saved for ' + scenarioName, 'success');
            closeInlineTagEditors();
            load();
        })
        .catch(function (e) {
            toast(e.message, 'error');
            saveBtn.disabled = false;
        });
}

/* ---------------- screenshot lightbox ---------------- */
function openLightbox(src) {
    if (!src) return;
    $('lightbox-image').src = src;
    $('lightbox-overlay').classList.remove('hidden');
}
function closeLightbox() {
    $('lightbox-overlay').classList.add('hidden');
    $('lightbox-image').src = '';
}
$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox-overlay').addEventListener('click', function (event) {
    if (event.target === this) closeLightbox();
});
document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !$('lightbox-overlay').classList.contains('hidden')) closeLightbox();
});

$('refresh').addEventListener('click', load);
$('run-tag').addEventListener('click', function () { startRun(''); });
$('run-feat').addEventListener('click', function () { startRun(this.getAttribute('data-tag') || '@feat'); });
$('run-batch').addEventListener('click', function () { startRun(this.getAttribute('data-tag') || '@batch'); });
$('stop-run').addEventListener('click', stopRun);
$('feature-select').addEventListener('change', render);
$('tag-select').addEventListener('change', function () {
    var currentTag = $('tag-select').value;
    $('run-tag-label').textContent = currentTag ? currentTag : (selectedFile() ? 'all in file' : 'all scenarios');
});

$('report-search').addEventListener('input', function () {
    reportQuery = this.value;
    $('report-search-clear').classList.toggle('hidden', !this.value);
    renderReports();
});
$('report-search-clear').addEventListener('click', function () {
    reportQuery = '';
    $('report-search').value = '';
    this.classList.add('hidden');
    renderReports();
    $('report-search').focus();
});
$('report-search').addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !this.value) return;
    this.value = '';
    reportQuery = '';
    $('report-search-clear').classList.add('hidden');
    renderReports();
});

$('save-feature').addEventListener('click', saveStudioFeature);
$('add-scenario').addEventListener('click', function () {
    var feature = readStudioForm();
    feature.scenarios.push({ name: 'New scenario', tags: [], steps: [{ keyword: 'Given ', name: 'a starting condition' }] });
    studioFeature = { uri: feature.uri, name: feature.name, description: feature.description, tags: feature.tags, background: feature.background || null, elements: feature.scenarios };
    renderStudio();
});
$('new-feature').addEventListener('click', function () {
    studioFeature = {
        uri: 'features/new-feature.feature', name: 'New feature', description: '', tags: [], background: null,
        elements: [{ keyword: 'Scenario', name: 'New scenario', tags: [], steps: [{ keyword: 'Given ', name: 'a starting condition' }] }]
    };
    studioOriginalUri = null;
    renderStudio();
});
$('tree-new-file').addEventListener('click', function () { startCreate('file', ''); });
$('tree-new-folder').addEventListener('click', function () { startCreate('folder', ''); });

/* ---------------- step definitions: event wiring ---------------- */
$('stepdef-file-select').addEventListener('change', function () {
    $('stepdef-new-file-row').classList.toggle('hidden', this.value !== '__new__');
    if (this.value !== '__new__') selectedStepDefFile = this.value;
    renderStepDefsExplorer();
    renderStepDefDetail();
});
$('stepdef-template').addEventListener('input', updateStepDefPreview);
$('stepdef-insert-placeholder').addEventListener('click', function () {
    var input = $('stepdef-template');
    var start = input.selectionStart == null ? input.value.length : input.selectionStart;
    var end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(0, start) + '"..."' + input.value.slice(end);
    input.focus();
    input.setSelectionRange(start + 5, start + 5);
    updateStepDefPreview();
});

/* ---------------- step definitions: implementation editor ---------------- */
$('stepdef-body').addEventListener('input', function () {
    syncStepDefBodyHighlight();
    updateStepDefAutocomplete();
});
$('stepdef-body').addEventListener('scroll', syncStepDefBodyScroll);
$('stepdef-body').addEventListener('blur', hideStepDefAutocomplete);
$('stepdef-body').addEventListener('keydown', function (event) {
    if (!stepDefAcMatches.length) return;
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        stepDefAcIndex = (stepDefAcIndex + 1) % stepDefAcMatches.length;
        renderStepDefAutocomplete();
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        stepDefAcIndex = (stepDefAcIndex - 1 + stepDefAcMatches.length) % stepDefAcMatches.length;
        renderStepDefAutocomplete();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        applyStepDefSnippet(stepDefAcIndex);
    } else if (event.key === 'Escape') {
        hideStepDefAutocomplete();
    }
});
// mousedown (not click) + preventDefault stops the textarea from blurring before the
// click registers, which would otherwise close the list first and swallow the click.
$('stepdef-autocomplete').addEventListener('mousedown', function (event) {
    var item = event.target.closest('.stepdef-autocomplete-item');
    if (!item) return;
    event.preventDefault();
    applyStepDefSnippet(Number(item.dataset.acIndex));
});

$('create-stepdef').addEventListener('click', saveStepDefinition);
$('cancel-stepdef-edit').addEventListener('click', cancelStepDefEdit);
// Explorer: selecting a file shows its steps in the detail panel below, and (unless a
// step is currently being edited, whose target file is fixed) also targets it for new steps.
$('stepdef-file-list').addEventListener('click', function (event) {
    var item = event.target.closest('.stepdef-file-item');
    if (!item) return;
    selectedStepDefFile = item.dataset.stepdefFile;
    if (!editingStep) {
        $('stepdef-file-select').value = selectedStepDefFile;
        $('stepdef-new-file-row').classList.add('hidden');
    }
    renderStepDefsExplorer();
    renderStepDefDetail();
});
// Detail panel: clicking a step's code loads it into the form for editing.
$('stepdef-detail-list').addEventListener('click', function (event) {
    var block = event.target.closest('.stepdef-code-block');
    if (block && block.dataset.stepdefEditFile) startEditStep(block);
});

// .folder-row and .file-item are divs (not <button>s, since they host real <button> action
// icons — see renderFileTree), so they need Enter/Space activation restored manually to stay
// keyboard-accessible.
document.addEventListener('keydown', function (event) {
    if (event.target.closest('.tree-action-btn')) return; // let the nested action button handle its own Enter/Space
    var treeRow = event.target.closest('.folder-row, .file-item');
    if (!treeRow || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    treeRow.click();
});

document.addEventListener('input', function (event) {
    var createInput = event.target.closest('.tree-create-input');
    if (createInput && pendingCreate) pendingCreate.value = createInput.value;
});
document.addEventListener('keydown', function (event) {
    if (!event.target.closest('.tree-create-input')) return;
    if (event.key === 'Enter') { event.preventDefault(); confirmPendingCreate(); }
    else if (event.key === 'Escape') { event.preventDefault(); cancelPendingCreate(); }
});
document.addEventListener('focusout', function (event) {
    if (!event.target.closest || !event.target.closest('.tree-create-input')) return;
    setTimeout(function () {
        if (!pendingCreate) return;
        var active = document.activeElement;
        if (active && active.classList && active.classList.contains('tree-create-input')) return;
        if (pendingCreate.value && pendingCreate.value.trim()) confirmPendingCreate();
        else cancelPendingCreate();
    }, 120);
});

/* ---------------- scenario recorder ---------------- */
var recording = null; // { sessionId, events, timer }

function openRecordDialog() {
    $('record-url').value = '';
    $('record-error').textContent = '';
    $('record-start').disabled = false;
    $('record-step-url').classList.remove('hidden');
    $('record-step-live').classList.add('hidden');
    $('record-overlay').classList.remove('hidden');
    setTimeout(function () { $('record-url').focus(); }, 0);
}

function closeRecordDialog() {
    $('record-overlay').classList.add('hidden');
}

function renderRecordSteps() {
    var events = (recording && recording.events) || [];
    var list = $('record-steps-list');
    if (!events.length) {
        list.innerHTML = '<div class="record-step-empty">No steps captured yet — click, fill in fields, or highlight text in the browser window.</div>';
        return;
    }
    list.innerHTML = events.map(function (e, i) {
        if (e.needsStep) {
            return '<div class="record-step-row needs-step">' +
                '<div class="record-step-row-head"><span class="kw">' + esc(e.keyword) + '</span><span>' + esc(e.text) + '</span><span class="new-step-badge">New step</span></div>' +
                '<p class="record-step-suggestion">' + esc((e.suggestion && e.suggestion.description) || '') + '</p>' +
                '<button class="btn btn-accent btn-sm request-step-btn" data-index="' + i + '">Request a Step</button>' +
                '</div>';
        }
        return '<div class="record-step-row"><span class="kw">' + esc(e.keyword) + '</span><span>' + esc(e.text) + '</span></div>';
    }).join('');
    list.scrollTop = list.scrollHeight;
}

function requestStepForRecording(index, button) {
    if (!recording) return;
    var sessionId = recording.sessionId;
    button.disabled = true;
    button.textContent = 'Creating…';
    FB.fetch('/api/record/request-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, eventIndex: index })
    })
        .then(function (r) { return r.json().then(function (p) { if (!r.ok) throw new Error(p.message || 'Could not create step.'); return p; }); })
        .then(function (data) {
            if (recording && recording.sessionId === sessionId && recording.events[index]) {
                recording.events[index] = data.event;
                renderRecordSteps();
            }
            toast(data.file ? ('Step definition added to ' + data.file) : 'That step already exists.', 'success');
            loadStepSuggestions();
        })
        .catch(function (e) {
            toast(e.message, 'error');
            button.disabled = false;
            button.textContent = 'Request a Step';
        });
}

function pollRecording() {
    if (!recording) return;
    var sessionId = recording.sessionId;
    FB.fetch('/api/record/events?sessionId=' + encodeURIComponent(sessionId) + '&since=' + recording.events.length)
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (!recording || recording.sessionId !== sessionId) return;
            if (data.events && data.events.length) {
                recording.events = recording.events.concat(data.events);
                renderRecordSteps();
            }
            if (data.error) {
                $('record-status-text').textContent = 'Browser error: ' + data.error;
            } else if (data.closed) {
                $('record-status-text').textContent = 'Browser window closed — finish to keep the captured steps, or discard.';
            }
        })
        .catch(function () {});
}

function stopRecordingTimer() {
    if (recording && recording.timer) {
        clearInterval(recording.timer);
        recording.timer = null;
    }
}

function startRecording() {
    var url = $('record-url').value.trim();
    if (!url) {
        $('record-error').textContent = 'Enter a URL to record against.';
        return;
    }
    $('record-error').textContent = '';
    $('record-start').disabled = true;
    FB.fetch('/api/record/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
    })
        .then(function (r) { return r.json().then(function (p) { if (!r.ok) throw new Error(p.message || 'Could not start recording.'); return p; }); })
        .then(function (data) {
            recording = { sessionId: data.sessionId, events: data.events || [], timer: null };
            $('record-step-url').classList.add('hidden');
            $('record-step-live').classList.remove('hidden');
            $('record-status-text').textContent = 'Recording — interact with the browser window that opened.';
            renderRecordSteps();
            recording.timer = setInterval(pollRecording, 1000);
        })
        .catch(function (e) {
            $('record-error').textContent = e.message;
            $('record-start').disabled = false;
        });
}

function addRecordedScenario(events) {
    var steps = (events || []).map(function (e) { return makeStep(e.keyword, e.text); });
    if (!steps.length) steps = [makeStep('Given', 'a starting condition')];
    var newScenario = { keyword: 'Scenario', name: 'Recorded scenario', tags: [], isOutline: false, examples: [], steps: steps };
    if (studioFeature) {
        var feature = readStudioForm();
        feature.scenarios.push(newScenario);
        studioFeature = { uri: feature.uri, name: feature.name, description: feature.description, tags: feature.tags, background: feature.background || null, elements: feature.scenarios };
    } else {
        studioFeature = {
            uri: 'features/new-feature.feature', name: 'New feature', description: '', tags: [], background: null,
            elements: [newScenario]
        };
        studioOriginalUri = null;
    }
    renderStudio();
    toast('Scenario created from recording · ' + steps.length + ' step' + (steps.length === 1 ? '' : 's'), 'success');
}

function discardRecording() {
    var sessionId = recording && recording.sessionId;
    stopRecordingTimer();
    recording = null;
    closeRecordDialog();
    if (sessionId) {
        FB.fetch('/api/record/stop', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId })
        }).catch(function () {});
    }
}

function finishRecording() {
    if (!recording) return;
    var sessionId = recording.sessionId;
    var capturedEvents = recording.events;
    stopRecordingTimer();
    FB.fetch('/api/record/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId })
    })
        .then(function (r) { return r.json(); })
        .then(function (data) { addRecordedScenario((data && data.events && data.events.length) ? data.events : capturedEvents); })
        .catch(function () { addRecordedScenario(capturedEvents); })
        .then(function () {
            recording = null;
            closeRecordDialog();
        });
}

$('record-scenario').addEventListener('click', openRecordDialog);
$('record-close').addEventListener('click', function () { if (recording) discardRecording(); else closeRecordDialog(); });
$('record-cancel-url').addEventListener('click', closeRecordDialog);
$('record-start').addEventListener('click', startRecording);
$('record-discard').addEventListener('click', discardRecording);
$('record-finish').addEventListener('click', finishRecording);
$('record-url').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); startRecording(); }
});
$('record-steps-list').addEventListener('click', function (event) {
    var btn = event.target.closest('.request-step-btn');
    if (!btn) return;
    requestStepForRecording(Number(btn.dataset.index), btn);
});

/* ---------------- live browser view ---------------- */
var liveAllowed = false;   // set once signed in — watching needs auth
var stopLiveWatch = null;

function renderLiveFrame(frame) {
    var hasFrame = !!(frame && frame.data);
    var img = $('live-frame');
    if (hasFrame) img.src = 'data:image/jpeg;base64,' + frame.data;
    img.classList.toggle('hidden', !hasFrame);
    $('live-placeholder').classList.toggle('hidden', hasFrame);
    $('live-viewport').classList.toggle('empty', !hasFrame);
    $('live-status').className = 'status-pill ' + (hasFrame ? 'running' : 'idle');
    $('live-status-text').textContent = hasFrame ? 'LIVE' : 'NO RUN';
    $('live-url').textContent = hasFrame ? (frame.url || '') : '';
}

// Only watch while the overview is actually on screen: frames are heavy, and the agent
// stops uploading them altogether when no dashboard is watching.
function syncLiveWatch() {
    var wanted = liveAllowed && !document.hidden && !$('view-overview').classList.contains('hidden');
    if (wanted && !stopLiveWatch) {
        stopLiveWatch = FB.watchLive(renderLiveFrame);
    }
    else if (!wanted && stopLiveWatch) {
        stopLiveWatch();
        stopLiveWatch = null;
        renderLiveFrame(null);
    }
}

document.addEventListener('visibilitychange', syncLiveWatch);

$('live-fullscreen').addEventListener('click', function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if ($('live-viewport').requestFullscreen) $('live-viewport').requestFullscreen();
});

/* ---------------- boot ---------------- */
syncStickyOffsets();
// Everything else reads/writes through Firebase (see firebase-client.js) — wait for a
// signed-in user before touching any of it, since FB.fetch() calls assume auth != null.
FB.ready.then(function () {
    load();
    loadStepSuggestions();
    setInterval(load, POLL_MS);
    liveAllowed = true;
    syncLiveWatch();
});
