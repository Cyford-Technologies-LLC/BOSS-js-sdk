/**
 * ZeroAI BOSS JS SDK - multi-page application wizard widget.
 *
 * BOSS project 50 task 140 (ZeroAI-CRM repo) - user-requested: a per-job application form
 * built with HR's new template/wizard builder should be embeddable on ANY external site with
 * zero code, Indeed-style multi-step UX, and resume auto-fill - not just usable through a raw
 * API call. Ships as a SEPARATE sibling file (per this SDK's own README/embed.js convention:
 * "a future Web-Components-based widget... would still ship as part of this same file or a
 * sibling one loaded by it"), loaded AFTER embed.js:
 *
 *   <script async src="https://zeroaiboss.com/v1/embed.js" data-client-id="YOUR_CLIENT_ID"></script>
 *   <script async src="https://zeroaiboss.com/v1/forms-wizard.js"></script>
 *   <div id="apply-here"></div>
 *   <script>
 *     window.ZeroAI.ready(function (sdk) {
 *       sdk.forms.renderWizard('#apply-here', { publicKey: 'THE_JOB_APPLICATION_PUBLIC_KEY' });
 *     });
 *   </script>
 *
 * Does NOT replace sdk.forms.submit() (the existing lead_capture embed-key submission already
 * built in embed.js) - this file only ADDS sdk.forms.renderWizard onto the same object, once
 * embed.js has finished initializing (via sdk.ready(), same hook any consumer would use).
 *
 * API contract consumed (ZeroAI-CRM repo, www/includes/integrations/form-builder):
 *   GET  {baseUrl}/forms/{public_key}/flow    -> { success, data: { pages: [...] } }
 *   POST {baseUrl}/forms/{public_key}/submit  -> { success, data: { submission_id, needs_uploads, next } }
 *   POST {legacyBase}/api/forms/upload.php         (multipart: public_key, submission_id, field_key, file)
 *   POST {legacyBase}/api/forms/parse-resume.php   (multipart: public_key, file) -> { fields: {...} }
 * A field's `maps_to` is never exposed by /flow - this widget only ever sends field_key/value
 * pairs, same as a developer hand-building their own form against this same public API would.
 *
 * Vanilla JS, ES5-compatible (var/function expressions, no template literals) - matches
 * embed.js's existing compatibility target, since this ships to every visitor's browser
 * regardless of the consuming site's own stack.
 */
(function (window, document) {
    'use strict';

    function whenReady(callback) {
        if (window.ZeroAI && window.ZeroAI.__bossEmbed) {
            window.ZeroAI.ready(callback);
        } else {
            // embed.js hasn't loaded/run yet (e.g. a script-order mistake, or this file
            // loaded first) - poll briefly rather than failing silently forever. A host
            // page that truly never loads embed.js just never gets a wizard, same failure
            // mode as any other SDK module depending on it.
            var attempts = 0;
            var timer = setInterval(function () {
                attempts++;
                if (window.ZeroAI && window.ZeroAI.__bossEmbed) {
                    clearInterval(timer);
                    window.ZeroAI.ready(callback);
                } else if (attempts > 100) { // ~10s at 100ms
                    clearInterval(timer);
                    if (window.console && console.warn) {
                        console.warn('[ZeroAI BOSS] forms-wizard.js loaded but embed.js never initialized - is the embed.js script tag present and loading first?');
                    }
                }
            }, 100);
        }
    }

    function legacyBaseUrl(config) {
        // Mirrors embed.js's own formsSubmitUrl() stripping convention: baseUrl is
        // ".../api/v2", but upload.php/parse-resume.php are plain (non-v2) endpoints at
        // the web root's /api/forms/ path.
        return config.baseUrl.replace(/\/api\/v2\/?$/, '');
    }

    function dispatch(name, detail) {
        try {
            document.dispatchEvent(new CustomEvent('zeroai:' + name, { detail: detail || {}, bubbles: true }));
        } catch (e) { /* ancient browser without CustomEvent - degrade silently */ }
    }

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        for (var k in attrs) {
            if (Object.prototype.hasOwnProperty.call(attrs, k)) {
                if (k === 'text') { node.textContent = attrs[k]; }
                else { node.setAttribute(k, attrs[k]); }
            }
        }
        for (var i = 0; i < (children || []).length; i++) {
            node.appendChild(children[i]);
        }
        return node;
    }

    function resolveContainer(selector) {
        return typeof selector === 'string' ? document.querySelector(selector) : selector;
    }

    // ---- Wizard runtime ---------------------------------------------------------

    function Wizard(config, container, options) {
        this.config = config;
        this.container = container;
        this.options = options || {};
        this.pages = [];
        this.pageIndex = 0;
        this.context = null; // signed FormSubmissionContext from the previous page's submission
        this.formData = {};  // field_key -> value, carried forward across pages (incl. resume pre-fill)
    }

    Wizard.prototype.start = function () {
        var self = this;
        this.renderLoading();
        fetch(this.config.baseUrl + '/forms/' + encodeURIComponent(this.options.publicKey) + '/flow')
            .then(function (r) { return r.json(); })
            .then(function (body) {
                if (!body || !body.success || !body.data || !body.data.pages || !body.data.pages.length) {
                    self.renderError((body && body.error && body.error.message) || 'This application is not available.');
                    return;
                }
                self.pages = body.data.pages;
                self.renderPage();
            })
            .catch(function (err) {
                self.renderError('Could not load this application.');
                dispatch('error', { source: 'forms-wizard', message: String(err && err.message || err) });
            });
    };

    Wizard.prototype.renderLoading = function () {
        this.container.innerHTML = '';
        this.container.appendChild(el('div', { 'class': 'zeroai-wizard-loading', text: 'Loading application...' }));
    };

    Wizard.prototype.renderError = function (message) {
        this.container.innerHTML = '';
        this.container.appendChild(el('div', { 'class': 'zeroai-wizard-error', text: message }));
    };

    Wizard.prototype.currentPage = function () {
        return this.pages[this.pageIndex];
    };

    Wizard.prototype.renderPage = function () {
        var self = this;
        var page = this.currentPage();
        this.container.innerHTML = '';

        var form = el('form', { 'class': 'zeroai-wizard-form' });
        if (this.pages.length > 1) {
            form.appendChild(el('div', {
                'class': 'zeroai-wizard-progress',
                text: 'Step ' + (this.pageIndex + 1) + ' of ' + this.pages.length,
            }));
        }
        if (page.name) {
            form.appendChild(el('h3', { 'class': 'zeroai-wizard-title', text: page.name }));
        }
        if (page.description) {
            form.appendChild(el('p', { 'class': 'zeroai-wizard-description', text: page.description }));
        }

        var fieldEls = {};
        for (var i = 0; i < page.fields.length; i++) {
            var field = page.fields[i];
            var wrap = el('div', { 'class': 'zeroai-wizard-field' });
            var label = el('label', { 'for': 'zw_' + field.field_key, text: field.label + (field.required ? ' *' : '') });
            wrap.appendChild(label);

            var input = this.buildInput(field);
            // Pre-fill from formData (resume auto-fill, or a value carried forward from a
            // previous page) -- never for a file input, which browsers never allow setting
            // .value on programmatically, for obvious security reasons.
            if (field.field_type !== 'file' && this.formData[field.field_key] !== undefined) {
                input.value = this.formData[field.field_key];
            }
            wrap.appendChild(input);
            fieldEls[field.field_key] = input;

            if (field.field_type === 'file') {
                input.addEventListener('change', function () {
                    self.maybeParseResume(this);
                });
            }

            form.appendChild(wrap);
        }

        var errorBox = el('div', { 'class': 'zeroai-wizard-error-inline' });
        form.appendChild(errorBox);

        var actions = el('div', { 'class': 'zeroai-wizard-actions' });
        if (this.pageIndex > 0) {
            var backBtn = el('button', { type: 'button', 'class': 'zeroai-wizard-back', text: 'Back' });
            backBtn.addEventListener('click', function () {
                self.pageIndex--;
                self.renderPage();
            });
            actions.appendChild(backBtn);
        }
        var isLast = this.pageIndex === this.pages.length - 1;
        var nextBtn = el('button', { type: 'submit', 'class': 'zeroai-wizard-next', text: isLast ? (this.options.submitLabel || 'Submit Application') : 'Next' });
        actions.appendChild(nextBtn);
        form.appendChild(actions);

        form.addEventListener('submit', function (evt) {
            evt.preventDefault();
            self.submitPage(page, fieldEls, errorBox, nextBtn);
        });

        this.container.appendChild(form);
    };

    Wizard.prototype.buildInput = function (field) {
        var id = 'zw_' + field.field_key;
        var common = { id: id, name: field.field_key };
        if (field.required) { common.required = 'required'; }

        if (field.field_type === 'textarea') {
            return el('textarea', common);
        }
        if (field.field_type === 'select') {
            var select = el('select', common);
            select.appendChild(el('option', { value: '', text: '-- Select --' }));
            for (var i = 0; i < (field.options || []).length; i++) {
                select.appendChild(el('option', { value: field.options[i], text: field.options[i] }));
            }
            return select;
        }
        if (field.field_type === 'checkbox') {
            var cb = el('input', common);
            cb.type = 'checkbox';
            return cb;
        }
        if (field.field_type === 'file') {
            var fileInput = el('input', common);
            fileInput.type = 'file';
            return fileInput;
        }
        var typeMap = { email: 'email', phone: 'tel', date: 'date' };
        var input = el('input', common);
        input.type = typeMap[field.field_type] || 'text';
        return input;
    };

    /** Auto-fill assist: whenever ANY file field changes, try resume parsing against it. Non-fatal, silent on failure/unsupported type (server returns {fields: {}} rather than erroring). */
    Wizard.prototype.maybeParseResume = function (fileInput) {
        var self = this;
        if (!fileInput.files || !fileInput.files.length) {
            return;
        }
        var body = new FormData();
        body.append('public_key', this.currentPage().public_key);
        body.append('file', fileInput.files[0]);

        fetch(legacyBaseUrl(this.config) + '/api/forms/parse-resume.php', { method: 'POST', body: body })
            .then(function (r) { return r.json(); })
            .then(function (result) {
                if (!result || !result.success || !result.fields) {
                    return;
                }
                var applied = [];
                for (var key in result.fields) {
                    if (!Object.prototype.hasOwnProperty.call(result.fields, key)) { continue; }
                    self.formData[key] = result.fields[key];
                    var visibleInput = self.container.querySelector('#zw_' + key);
                    if (visibleInput && !visibleInput.value) {
                        visibleInput.value = result.fields[key];
                        applied.push(key);
                    }
                }
                dispatch('resume-parsed', { fields: result.fields, appliedToVisibleFields: applied });
            })
            .catch(function () { /* best-effort auto-fill - never block the applicant on this failing */ });
    };

    Wizard.prototype.submitPage = function (page, fieldEls, errorBox, submitBtn) {
        var self = this;
        errorBox.textContent = '';

        var values = {};
        var fileFields = [];
        for (var key in fieldEls) {
            if (!Object.prototype.hasOwnProperty.call(fieldEls, key)) { continue; }
            var input = fieldEls[key];
            if (input.type === 'file') {
                fileFields.push(key);
                continue;
            }
            if (input.type === 'checkbox') {
                values[key] = input.checked ? '1' : '';
            } else {
                values[key] = input.value;
                this.formData[key] = input.value;
            }
        }

        submitBtn.disabled = true;
        var payload = { values: values };
        if (this.context) {
            payload.context = this.context;
        }

        fetch(this.config.baseUrl + '/forms/' + encodeURIComponent(page.public_key) + '/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
            .then(function (result) {
                if (!result.ok || !result.body || !result.body.success) {
                    var msg = (result.body && result.body.error && result.body.error.message) || 'Could not submit this page. Please check your answers and try again.';
                    errorBox.textContent = msg;
                    submitBtn.disabled = false;
                    dispatch('error', { source: 'forms-wizard', message: msg });
                    return;
                }
                var data = result.body.data;
                self.uploadFiles(page, fieldEls, fileFields, data.submission_id).then(function () {
                    if (data.next) {
                        self.context = data.next.context;
                        self.pageIndex++;
                        self.renderPage();
                    } else {
                        self.renderSuccess();
                        dispatch('application-submitted', { publicKey: page.public_key, submissionId: data.submission_id });
                        if (typeof self.options.onSubmit === 'function') {
                            self.options.onSubmit({ submissionId: data.submission_id });
                        }
                    }
                });
            })
            .catch(function (err) {
                errorBox.textContent = 'Network error -- please try again.';
                submitBtn.disabled = false;
                dispatch('error', { source: 'forms-wizard', message: String(err && err.message || err) });
            });
    };

    Wizard.prototype.uploadFiles = function (page, fieldEls, fileFields, submissionId) {
        var self = this;
        var uploads = [];
        for (var i = 0; i < fileFields.length; i++) {
            var key = fileFields[i];
            var input = fieldEls[key];
            if (input.files && input.files.length) {
                uploads.push(self.uploadOneFile(page.public_key, submissionId, key, input.files[0]));
            }
        }
        return Promise.all(uploads).catch(function () { /* a failed file upload shouldn't block wizard progress -- the submission itself already succeeded */ });
    };

    Wizard.prototype.uploadOneFile = function (publicKey, submissionId, fieldKey, file) {
        var body = new FormData();
        body.append('public_key', publicKey);
        body.append('submission_id', submissionId);
        body.append('field_key', fieldKey);
        body.append('file', file);
        return fetch(legacyBaseUrl(this.config) + '/api/forms/upload.php', { method: 'POST', body: body })
            .then(function (r) { return r.json(); });
    };

    Wizard.prototype.renderSuccess = function () {
        this.container.innerHTML = '';
        this.container.appendChild(el('div', {
            'class': 'zeroai-wizard-success',
            text: this.options.successMessage || 'Thanks! Your application has been submitted.',
        }));
    };

    // ---- Install onto window.ZeroAI.forms ----------------------------------------

    whenReady(function (sdk) {
        if (!sdk.forms) {
            sdk.forms = {};
        }
        sdk.forms.renderWizard = function (selector, options) {
            var container = resolveContainer(selector);
            if (!container) {
                if (window.console && console.warn) {
                    console.warn('[ZeroAI BOSS] forms.renderWizard: container not found for "' + selector + '"');
                }
                return null;
            }
            if (!options || !options.publicKey) {
                if (window.console && console.warn) {
                    console.warn('[ZeroAI BOSS] forms.renderWizard: options.publicKey is required.');
                }
                return null;
            }
            var wizard = new Wizard(sdk.config, container, options);
            wizard.start();
            return wizard;
        };
    });
})(window, document);
