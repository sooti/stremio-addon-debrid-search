// --- Mobile-Friendly Rebrand ---
// - Added the viewport meta tag for proper mobile scaling.
// - Switched to 'rem' units for scalable typography.
// - Updated #addon styles to be responsive by default.
// - Added a @media query to fine-tune styles for screens under 768px.

const STYLESHEET = `
* {
	box-sizing: border-box;
}

body,
html {
	margin: 0;
	padding: 0;
	width: 100%;
	min-height: 100%;
}

html {
    background-color: #0a192f;
	background-size: cover;
	background-position: center center;
	background-repeat: no-repeat;
    font-size: 16px; /* Set a base font size */
}

body {
	font-family: 'Open Sans', Arial, sans-serif;
	color: #ccd6f6;
    line-height: 1.5;
    padding: 2em 1em; /* Top padding for banner effect */
}

#addon {
    width: 90%; /* Use percentage for responsive width */
    max-width: 700px; /* Max width for larger screens */
    margin: auto;
    padding: 1em 3em 2em;
    background: rgba(10, 25, 47, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 15px;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
}

/* Performance optimization for mobile */
@media (max-width: 768px) {
    .container {
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
        padding: 1.5em 1.5em;
    }
}

.logo {
	height: 60px;
	width: 60px;
	margin: 0 auto 0.75em;
}

.logo img {
	width: 100%;
}

h1 {
	font-size: 1.5rem;
	font-weight: 700;
    text-align: center;
    color: #fff;
}

h2 {
	font-size: 0.9rem;
	font-weight: normal;
	font-style: italic;
	opacity: 0.8;
    text-align: center;
    margin-top: 0.5em;
}

h3 {
	font-size: 1.2rem;
    font-weight: 600;
    color: #64ffda;
    border-bottom: 1px solid #233554;
    padding-bottom: 0.5em;
    margin-top: 1.5em;
}

h1, h2, h3, p, label {
	margin: 0;
	text-shadow: 0 0 10px rgba(0, 0, 0, 0.2);
}

a {
	color: #64ffda;
    text-decoration: none;
    transition: color 0.2s ease-in-out;
}

a:hover {
    color: #fff;
}

ul {
    margin: 1em 0;
    padding-left: 20px;
    list-style: none;
}

li {
    margin-top: 0.5em;
    position: relative;
}

li::before {
    content: '▹';
    position: absolute;
    left: -20px;
    color: #64ffda;
}

.separator {
	margin: 2em 0;
    border: 0;
    height: 1px;
    background-color: #233554;
}

.form-element {
	margin-bottom: 1.5em;
}

.label-to-top {
    display: block;
    margin-bottom: 0.5em;
    font-weight: 600;
    color: #ccd6f6;
}

.full-width {
    width: 100%;
}

select, input[type="text"] {
    background-color: #112240;
    border: 1px solid #233554;
    color: #ccd6f6;
    padding: 0.8em;
    border-radius: 5px;
    font-size: 1rem;
    transition: border-color 0.2s ease-in-out;
}

select:focus, input[type="text"]:focus {
    outline: none;
    border-color: #64ffda;
}

.checkbox-container {
    display: flex;
    align-items: center;
    margin-top: 1em;
}

input[type="checkbox"] {
    margin-right: 10px;
    accent-color: #64ffda;
    width: 1.2em;
    height: 1.2em;
}

/* Shoelace component styling - minimal overrides */
sl-select {
    margin-bottom: 0.75rem;
}

input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 8px;
    background: #233554;
    border-radius: 5px;
    outline: none;
    transition: background 0.2s ease-in-out;
}

input[type="range"]:hover {
    background: #2d4366;
}

input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    background: #64ffda;
    border-radius: 50%;
    cursor: pointer;
    transition: background 0.2s ease-in-out;
}

input[type="range"]::-webkit-slider-thumb:hover {
    background: #52d4c2;
}

input[type="range"]::-moz-range-thumb {
    width: 20px;
    height: 20px;
    background: #64ffda;
    border-radius: 50%;
    cursor: pointer;
    border: none;
    transition: background 0.2s ease-in-out;
}

input[type="range"]::-moz-range-thumb:hover {
    background: #52d4c2;
}

button {
	border: 1px solid #64ffda;
	outline: 0;
	color: #64ffda;
	background: transparent;
	padding: 0.8em 1.5em;
	margin: 1.5em auto 0;
	text-align: center;
	font-family: 'Open Sans', Arial, sans-serif;
	font-size: 1.1rem;
	font-weight: 600;
	cursor: pointer;
	display: block;
	border-radius: 5px;
	transition: background-color 0.2s ease-in-out, color 0.2s ease-in-out;
}

button:hover {
	background-color: rgba(100, 255, 218, 0.1);
}

button:active {
	background-color: rgba(100, 255, 218, 0.2);
}

.copy-link-btn {
	font-size: 0.9rem;
	padding: 0.6em 1.2em;
	margin: 0.5em auto 0;
	background: transparent;
}

.toast {
	position: fixed;
	bottom: 2em;
	left: 50%;
	transform: translateX(-50%);
	background: rgba(100, 255, 218, 0.9);
	color: #0a192f;
	padding: 1em 2em;
	border-radius: 5px;
	font-weight: 600;
	opacity: 0;
	transition: opacity 0.3s ease-in-out;
	z-index: 1000;
	pointer-events: none;
}

.toast.show {
	opacity: 1;
}

.contact {
	text-align: center;
    margin-top: 2em;
    opacity: 0.7;
}

/* --- COLLAPSIBLE SECTIONS --- */
.mobile-collapsible {
    display: none; /* Hidden on desktop */
}

.desktop-checkboxes {
    display: grid; /* Shown on desktop */
}

.mobile-collapsible summary {
    user-select: none;
}

.mobile-collapsible[open] summary .arrow {
    transform: rotate(180deg);
}

.mobile-collapsible summary .arrow {
    transition: transform 0.2s ease;
}

/* --- WIZARD STYLES --- */
.wizard-page {
    display: block;
}

.mobile-only {
    display: none;
}

.desktop-only {
    display: block;
}

@media (max-width: 768px) {
    .mobile-only {
        display: block;
    }

    .desktop-only {
        display: none !important;
    }

    /* Allow scrolling for mobile */
    body {
        padding: 1em 0;
        overflow-y: auto;
        min-height: 100vh;
    }

    #addon {
        width: 100vw;
        min-height: auto;
        display: flex;
        flex-direction: column;
        padding: 0.5em;
        margin: 0;
        overflow-y: auto;
        box-sizing: border-box;
    }

    /* Minimal header */
    .logo {
        height: 40px !important;
        width: 40px !important;
        margin: 0 auto 0.25em !important;
    }

    h1 {
        font-size: 1.1em !important;
        margin: 0 0 0.25em !important;
    }

    /* Form takes remaining space */
    #mainForm {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .wizard-page {
        animation: fadeIn 0.3s ease-in-out;
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        min-height: 0;
    }

    /* Content area that can grow and scroll if needed */
    .wizard-page > .form-element,
    .wizard-page > div:not(.wizard-header):not(.wizard-navigation) {
        flex-shrink: 0;
    }

    /* Minimal wizard header */
    .wizard-header {
        flex-shrink: 0;
        margin-bottom: 0.5em !important;
    }

    .wizard-progress {
        margin-bottom: 0.25em !important;
    }

    .wizard-step {
        width: 2em !important;
        height: 2em !important;
        font-size: 0.9em !important;
    }

    .wizard-line {
        width: 3em !important;
    }

    .wizard-header p {
        margin: 0.25em 0 !important;
        font-size: 0.75rem !important;
        line-height: 1.2 !important;
    }

    /* Hide all description text on mobile */
    .form-element > p,
    .form-element > label.label-to-top + p {
        display: none !important;
    }

    /* Compact form elements */
    .form-element {
        margin-bottom: 0.5em !important;
    }

    .form-element label {
        font-size: 0.85rem !important;
        margin-bottom: 0.25em !important;
    }

    input, select {
        font-size: 0.85rem !important;
        padding: 0.5em !important;
    }

    button {
        font-size: 0.85rem !important;
        padding: 0.5em 0.75em !important;
    }

    /* Minimal service rows */
    .service-row {
        padding: 0.5em !important;
        margin-bottom: 0.5em !important;
        gap: 0.5em !important;
    }

    .reorder-buttons {
        gap: 0.1em !important;
        min-width: 25px !important;
    }

    .reorder-btn {
        padding: 0.15em 0.3em !important;
        font-size: 0.75rem !important;
    }

    .remove-service {
        padding: 0.4em 0.6em !important;
        font-size: 0.75rem !important;
        margin-top: 0 !important;
    }

    /* Compact API key helper links */
    .api-key-link {
        margin-top: 0.25em !important;
        font-size: 0.75rem !important;
    }

    .api-key-link a {
        font-size: 0.75rem !important;
    }

    /* Compact wizard navigation - always visible at bottom */
    .wizard-navigation {
        position: sticky !important;
        bottom: 0 !important;
        margin-top: 0.5em !important;
        padding: 0.5em 0 !important;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(10, 25, 47, 0.95) !important;
        backdrop-filter: blur(10px) !important;
        flex-shrink: 0;
        z-index: 10;
    }

    .wizard-btn {
        padding: 0.6em 1em !important;
        font-size: 0.85rem !important;
    }

    /* Hide pages 2 and 3 by default on mobile */
    #wizardPage2, #wizardPage3 {
        display: none;
    }

    /* Compact install buttons - sticky at bottom */
    #installButtons {
        display: none;
        position: sticky;
        bottom: 0;
        margin-top: 0.5em;
        padding: 0.5em 0;
        background: rgba(10, 25, 47, 0.95);
        backdrop-filter: blur(10px);
        flex-shrink: 0;
        z-index: 10;
    }

    #installButtons.visible {
        display: block;
        animation: fadeIn 0.3s ease-in-out;
    }

    .install-link button,
    .copy-link-btn {
        padding: 0.6em 1em !important;
        font-size: 0.85rem !important;
        margin: 0.25em auto !important;
    }

    .toast {
        bottom: 1em !important;
        padding: 0.75em 1.5em !important;
        font-size: 0.85rem !important;
    }

    /* Hide collapsible details summaries on mobile, keep content visible */
    details.mobile-collapsible {
        display: block !important;
    }

    details.mobile-collapsible summary {
        display: none !important;
    }

    details.mobile-collapsible > div {
        display: block !important;
        padding: 0 !important;
    }

    /* Make checkbox grids more compact */
    details.mobile-collapsible > div {
        display: grid !important;
        grid-template-columns: 1fr !important;
        gap: 0.25em !important;
        min-height: 50px !important;
        opacity: 1 !important;
        visibility: visible !important;
    }

    details.mobile-collapsible label {
        font-size: 0.8rem !important;
        padding: 0.25em 0 !important;
        display: flex !important;
        align-items: center !important;
    }

    details.mobile-collapsible input[type="checkbox"] {
        width: 1em !important;
        height: 1em !important;
        margin-right: 0.5em !important;
        display: inline-block !important;
    }

    /* Compact range sliders */
    input[type="range"] {
        height: 1.5em !important;
    }

    #minSizeLabel, #maxSizeLabel {
        font-size: 0.75rem !important;
    }

    /* Compact separators */
    .separator {
        margin: 0.5em 0 !important;
    }

    /* Compact checkbox containers */
    .checkbox-container {
        margin-bottom: 0.5em !important;
    }

    .checkbox-container input[type="checkbox"] {
        width: 1em !important;
        height: 1em !important;
    }

    .checkbox-container label {
        font-size: 0.8rem !important;
    }

    .wizard-progress {
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 0.5em;
    }

    .wizard-step {
        width: 2.5em;
        height: 2.5em;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 1.1em;
        background: rgba(35, 53, 84, 0.5);
        border: 2px solid rgba(100, 255, 218, 0.3);
        color: rgba(100, 255, 218, 0.5);
        transition: all 0.3s ease;
    }

    .wizard-step.active {
        background: rgba(100, 255, 218, 0.2);
        border-color: #64ffda;
        color: #64ffda;
        box-shadow: 0 0 15px rgba(100, 255, 218, 0.3);
    }

    .wizard-step.completed {
        background: #64ffda;
        border-color: #64ffda;
        color: #0a192f;
    }

    .wizard-line {
        width: 4em;
        height: 2px;
        background: rgba(100, 255, 218, 0.3);
        margin: 0 0.5em;
        transition: all 0.3s ease;
    }

    .wizard-line.active {
        background: #64ffda;
    }

    .wizard-navigation {
        display: flex;
        gap: 1em;
        margin-top: 2em;
        padding-top: 1em;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
    }

    .wizard-btn {
        flex: 1;
        padding: 0.9em 1.5em;
        font-size: 1rem;
        font-weight: 600;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s ease;
        font-family: 'Open Sans', Arial, sans-serif;
    }

    .wizard-btn-next {
        background: #64ffda;
        color: #0a192f;
    }

    .wizard-btn-next:active {
        background: #52d4c2;
        transform: scale(0.98);
    }

    .wizard-btn-back {
        background: rgba(100, 255, 218, 0.1);
        color: #64ffda;
        border: 1px solid rgba(100, 255, 218, 0.3);
    }

    .wizard-btn-back:active {
        background: rgba(100, 255, 218, 0.2);
        transform: scale(0.98);
    }
}

@keyframes fadeIn {
    from {
        opacity: 0;
        transform: translateY(10px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

/* --- SERVICE ROW STYLES --- */
.service-row {
	transition: all 0.3s ease;
	position: relative;
}

.reorder-buttons {
	display: flex;
	flex-direction: column;
	gap: 0.2em;
	margin-right: 0.5em;
	min-width: 30px;
}

.reorder-btn {
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	color: #64ffda;
	font-size: 1rem;
	user-select: none;
	-webkit-user-select: none;
	-moz-user-select: none;
	-ms-user-select: none;
	opacity: 0.6;
	transition: opacity 0.2s ease, transform 0.2s ease, background-color 0.2s ease;
	padding: 0.3em;
	background: rgba(100, 255, 218, 0.1);
	border-radius: 3px;
	border: 1px solid rgba(100, 255, 218, 0.2);
	width: 30px;
	height: 25px;
}

.reorder-btn:hover {
	opacity: 1;
	background: rgba(100, 255, 218, 0.15);
	border-color: rgba(100, 255, 218, 0.4);
}

.reorder-btn:active {
	background: rgba(100, 255, 218, 0.2);
	transform: scale(0.95);
}

.reorder-btn:disabled {
	opacity: 0.2;
	cursor: not-allowed;
}

.service-row:hover .reorder-btn {
	opacity: 0.8;
}

/* --- NEW: MEDIA QUERY FOR MOBILE DEVICES --- */
@media (max-width: 768px) {
    body {
        font-size: 14px; /* Slightly smaller base font on mobile */
        display: block; /* Let content flow from top */
    }

    #addon {
        width: 100%;
        max-width: none;
        padding: 2em 1.5em;
        margin: 0;
        border-radius: 0;
        border: none;
    }

    h1 {
        font-size: 2rem;
    }

    /* On mobile, show collapsible sections and hide desktop checkboxes */
    .mobile-collapsible {
        display: block !important;
    }

    .desktop-checkboxes {
        display: none !important;
    }
}
`

function landingTemplate(manifest, config = {}) {
    const background = 'https://images.unsplash.com/photo-1534796636912-3b95b3ab5986?q=80&w=2071&auto=format&fit=crop&ixlib=rb-4.0.3&ixid=M3wxMJA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D';
    const logo = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%2364ffda;stop-opacity:1' /%3E%3Cstop offset='100%25' style='stop-color:%2300A7B5;stop-opacity:1' /%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath fill='url(%23grad)' d='M50,5 C74.85,5 95,25.15 95,50 C95,74.85 74.85,95 50,95 C35,95 22.33,87.6 15,76 C25,85 40,85 50,80 C60,75 65,65 65,50 C65,35 55,25 40,25 C25,25 15,40 15,50 C15,55 16,60 18,64 C8.5,58 5,45 5,50 C5,25.15 25.15,5 50,5 Z'/%3E%3C/svg%3E";
    const contactHTML = manifest.contactEmail ?
        `<div class="contact">
            <p>Contact ${manifest.name} creator:</p>
            <a href="mailto:${manifest.contactEmail}">${manifest.contactEmail}</a>
        </div>` : ''

    // Custom HTML support from environment variable
    const customDescriptionBlurb = process.env.CUSTOM_HTML || '';

    let formHTML = ''
    let script = ''

	formHTML = `
	<form class="pure-form" id="mainForm">
		<!-- Wizard Page 1: Essential Settings -->
		<div class="wizard-page" id="wizardPage1">
			<div class="wizard-header mobile-only">
				<div class="wizard-progress">
					<div class="wizard-step active">1</div>
					<div class="wizard-line"></div>
					<div class="wizard-step">2</div>
					<div class="wizard-line"></div>
					<div class="wizard-step">3</div>
				</div>
				<p style="text-align: center; margin: 1em 0 0.5em; opacity: 0.8; font-size: 0.9rem;">Step 1 of 3: Add Services</p>
			</div>

			<div class="form-element">
				<label class="label-to-top">Debrid & Usenet Services</label>
				<p style="opacity: 0.7; font-size: 0.9rem; margin-bottom: 1em;">Add one or more services. All services will be queried simultaneously. Use ▲ ▼ arrows to reorder services.</p>
				<div id="debridServicesContainer"></div>
				<button type="button" id="addServiceBtn" style="margin: 1em 0; padding: 0.5em 1em; font-size: 0.9rem;">+ Add Service</button>
			</div>

			<div class="wizard-navigation mobile-only">
				<button type="button" class="wizard-btn wizard-btn-next" id="nextToPage2">Next: Scrapers →</button>
			</div>
		</div>

		<!-- Wizard Page 2: Scrapers -->
		<div class="wizard-page" id="wizardPage2">
			<div class="wizard-header mobile-only">
				<div class="wizard-progress">
					<div class="wizard-step completed">✓</div>
					<div class="wizard-line active"></div>
					<div class="wizard-step active">2</div>
					<div class="wizard-line"></div>
					<div class="wizard-step">3</div>
				</div>
				<p style="text-align: center; margin: 1em 0 0.5em; opacity: 0.8; font-size: 0.9rem;">Step 2 of 3: Scrapers (Optional)</p>
				<p style="text-align: center; margin: 0 0 1.5em; padding: 0.8em; background: rgba(100, 255, 218, 0.1); border-radius: 8px; font-size: 0.85rem; color: #64ffda; border: 1px solid rgba(100, 255, 218, 0.2);">
					Optional: Select scrapers for more torrent results. Skip if you only want cached results.
				</p>
			</div>

		<hr class="separator desktop-only" id="scrapersSection" style="display: none;">

		<div class="form-element" id="torrentScrapersSection" style="display: none;">
			<sl-select id="Scrapers" name="Scrapers" multiple clearable label="Torrent Scrapers (optional)" placeholder="Select torrent scrapers" help-text="More scrapers = more results but slower response times." hoist max-options-visible="3">
				${process.env.JACKETT_ENABLED === 'true' ? '<sl-option value="jackett">Jackett (Meta-Tracker)</sl-option>' : ''}
				${process.env.TORRENT_1337X_ENABLED === 'true' ? '<sl-option value="1337x">1337x</sl-option>' : ''}
				${process.env.TORRENT9_ENABLED === 'true' ? '<sl-option value="torrent9">Torrent9</sl-option>' : ''}
				${process.env.BTDIG_ENABLED === 'true' ? '<sl-option value="btdig">BTDigg</sl-option>' : ''}
				${process.env.SNOWFL_ENABLED === 'true' ? '<sl-option value="snowfl">Snowfl</sl-option>' : ''}
				${process.env.MAGNETDL_ENABLED === 'true' ? '<sl-option value="magnetdl">MagnetDL</sl-option>' : ''}
				${process.env.WOLFMAX4K_ENABLED === 'true' ? '<sl-option value="wolfmax4k">Wolfmax4K (Spanish)</sl-option>' : ''}
				${process.env.BLUDV_ENABLED === 'true' ? '<sl-option value="bludv">BluDV (Portuguese)</sl-option>' : ''}
				${process.env.BITMAGNET_ENABLED === 'true' ? '<sl-option value="bitmagnet">Bitmagnet</sl-option>' : ''}
				${process.env.KNABEN_ENABLED === 'true' ? '<sl-option value="knaben">Knaben</sl-option>' : ''}
			</sl-select>
		</div>

		${process.env.ZILEAN_ENABLED === 'true' || process.env.TORRENTIO_ENABLED === 'true' || process.env.COMET_ENABLED === 'true' || process.env.STREMTHRU_ENABLED === 'true' ? `
		<div class="form-element" id="indexerScrapersSection" style="display: none;">
			<sl-select id="IndexerScrapers" name="IndexerScrapers" multiple clearable label="Indexer Scrapers (optional)" placeholder="Select indexer scrapers" help-text="Direct indexer access for better results." hoist max-options-visible="3">
				${process.env.ZILEAN_ENABLED === 'true' ? '<sl-option value="zilean">Zilean (Direct Indexer Access)</sl-option>' : ''}
				${process.env.TORRENTIO_ENABLED === 'true' ? '<sl-option value="torrentio">Torrentio (Direct Indexer Access)</sl-option>' : ''}
				${process.env.COMET_ENABLED === 'true' ? '<sl-option value="comet">Comet (Direct Indexer Access)</sl-option>' : ''}
				${process.env.STREMTHRU_ENABLED === 'true' ? '<sl-option value="stremthru">StremThru (Direct Indexer Access)</sl-option>' : ''}
			</sl-select>
		</div>
		` : ''}

		<div class="wizard-navigation mobile-only">
			<button type="button" class="wizard-btn wizard-btn-back" id="backToPage1">← Back</button>
			<button type="button" class="wizard-btn wizard-btn-next" id="nextToPage3">Next: Filters →</button>
		</div>
	</div>
	<!-- End Wizard Page 2 -->

	<!-- Wizard Page 3: Filters -->
	<div class="wizard-page" id="wizardPage3">
		<div class="wizard-header mobile-only">
			<div class="wizard-progress">
				<div class="wizard-step completed">✓</div>
				<div class="wizard-line active"></div>
				<div class="wizard-step completed">✓</div>
				<div class="wizard-line active"></div>
				<div class="wizard-step active">3</div>
			</div>
			<p style="text-align: center; margin: 1em 0 0.5em; opacity: 0.8; font-size: 0.9rem;">Step 3 of 3: Filters & Options</p>
			<p style="text-align: center; margin: 0 0 1.5em; padding: 0.8em; background: rgba(100, 255, 218, 0.1); border-radius: 8px; font-size: 0.85rem; color: #64ffda; border: 1px solid rgba(100, 255, 218, 0.2);">
				Optional: Configure filters for languages, file size, and catalog display.
			</p>
		</div>

		<hr class="separator desktop-only">

		<div class="form-element">
			<sl-select id="Languages" name="Languages" multiple clearable label="Filter by Languages (optional)" placeholder="Select languages" help-text="No selection = no filter. English includes unlabeled." hoist max-options-visible="3">
				<sl-option value="english">🇬🇧 English</sl-option>
				<sl-option value="spanish">🇪🇸 Spanish</sl-option>
				<sl-option value="latino">🇲🇽 Latino</sl-option>
				<sl-option value="french">🇫🇷 French</sl-option>
				<sl-option value="german">🇩🇪 German</sl-option>
				<sl-option value="italian">🇮🇹 Italian</sl-option>
				<sl-option value="portuguese">🇵🇹 Portuguese</sl-option>
				<sl-option value="russian">🇷🇺 Russian</sl-option>
				<sl-option value="japanese">🇯🇵 Japanese</sl-option>
				<sl-option value="korean">🇰🇷 Korean</sl-option>
				<sl-option value="chinese">🇨🇳 Chinese</sl-option>
				<sl-option value="taiwanese">🇹🇼 Taiwanese</sl-option>
				<sl-option value="hindi">🇮🇳 Hindi</sl-option>
				<sl-option value="tamil">🇮🇳 Tamil</sl-option>
				<sl-option value="telugu">🇮🇳 Telugu</sl-option>
				<sl-option value="arabic">🇸🇦 Arabic</sl-option>
				<sl-option value="turkish">🇹🇷 Turkish</sl-option>
				<sl-option value="dutch">🇳🇱 Dutch</sl-option>
				<sl-option value="polish">🇵🇱 Polish</sl-option>
				<sl-option value="czech">🇨🇿 Czech</sl-option>
				<sl-option value="hungarian">🇭🇺 Hungarian</sl-option>
				<sl-option value="romanian">🇷🇴 Romanian</sl-option>
				<sl-option value="bulgarian">🇧🇬 Bulgarian</sl-option>
				<sl-option value="serbian">🇷🇸 Serbian</sl-option>
				<sl-option value="croatian">🇭🇷 Croatian</sl-option>
				<sl-option value="ukrainian">🇺🇦 Ukrainian</sl-option>
				<sl-option value="greek">🇬🇷 Greek</sl-option>
				<sl-option value="swedish">🇸🇪 Swedish</sl-option>
				<sl-option value="norwegian">🇳🇴 Norwegian</sl-option>
				<sl-option value="danish">🇩🇰 Danish</sl-option>
				<sl-option value="finnish">🇫🇮 Finnish</sl-option>
				<sl-option value="hebrew">🇮🇱 Hebrew</sl-option>
				<sl-option value="persian">🇮🇷 Persian</sl-option>
				<sl-option value="thai">🇹🇭 Thai</sl-option>
				<sl-option value="vietnamese">🇻🇳 Vietnamese</sl-option>
				<sl-option value="indonesian">🇮🇩 Indonesian</sl-option>
				<sl-option value="malay">🇲🇾 Malay</sl-option>
				<sl-option value="lithuanian">🇱🇹 Lithuanian</sl-option>
				<sl-option value="latvian">🇱🇻 Latvian</sl-option>
				<sl-option value="estonian">🇪🇪 Estonian</sl-option>
				<sl-option value="slovakian">🇸🇰 Slovakian</sl-option>
				<sl-option value="slovenian">🇸🇮 Slovenian</sl-option>
			</sl-select>
		</div>

		<div class="form-element">
			<label class="label-to-top">Filter by File Size (optional)</label>
			<div style="margin-bottom: 1em;">
				<div style="display: flex; justify-content: space-between; margin-bottom: 0.5em;">
					<span style="font-size: 0.9rem;">Min: <span id="minSizeLabel">0 GB</span></span>
					<span style="font-size: 0.9rem;">Max: <span id="maxSizeLabel">200 GB</span></span>
				</div>
				<div style="display: flex; gap: 1em; align-items: center;">
					<input type="range" id="minSize" name="minSize" min="0" max="200" value="0" step="1" class="full-width" style="flex: 1;" oninput="document.getElementById('minSizeLabel').textContent = this.value + ' GB'">
					<input type="range" id="maxSize" name="maxSize" min="0" max="200" value="200" step="1" class="full-width" style="flex: 1;" oninput="document.getElementById('maxSizeLabel').textContent = this.value + ' GB'">
				</div>
			</div>
			<p style="opacity: 0.7; font-size: 0.9rem;">Filter streams by file size. Drag sliders to set min/max size in GB. Set to 0-200 for no filtering.</p>
		</div>

		<div class="form-element checkbox-container">
			<input type="checkbox" id="ShowCatalog" name="ShowCatalog" value="true" checked>
            <label for="ShowCatalog">Show personal downloads catalog</label>
		</div>

		<div class="wizard-navigation mobile-only">
			<button type="button" class="wizard-btn wizard-btn-back" id="backToPage2">← Back</button>
		</div>
	</div>
	<!-- End Wizard Page 3 -->
	</form>

	<!-- Install buttons - shown after form -->
	<div id="installButtons">
		<a id="installLink" class="install-link" href="#">
			<button name="Install">INSTALL ADDON</button>
		</a>
		<button id="copyLinkBtn" class="copy-link-btn">COPY MANIFEST LINK</button>
		<div id="toast" class="toast">Manifest link copied to clipboard!</div>
	</div>
	`

	script += `
	const mainForm = document.getElementById('mainForm');
	const installLink = document.getElementById('installLink');
	const container = document.getElementById('debridServicesContainer');
	const addServiceBtn = document.getElementById('addServiceBtn');
	const usenetEnabled = document.getElementById('UsenetEnabled');
	const usenetConfig = document.getElementById('usenetConfig');

	let serviceIndex = 0;

	const scrapersSelect = document.getElementById('Scrapers');
	const indexerScrapersSelect = document.getElementById('IndexerScrapers');
	const languagesSelect = document.getElementById('Languages');

	// Debounce function to reduce excessive updateLink calls
	const debounce = (func, wait) => {
		let timeout;
		return function executedFunction(...args) {
			const later = () => {
				clearTimeout(timeout);
				func(...args);
			};
			clearTimeout(timeout);
			timeout = setTimeout(later, wait);
		};
	};

// Initialize with existing config or one empty service
const existingServices = ${JSON.stringify(config.DebridServices || (config.DebridProvider ? [{ provider: config.DebridProvider, apiKey: config.DebridApiKey }] : [{ provider: process.env.DEFAULT_DEBRID_SERVICE || 'RealDebrid', apiKey: '' }]))};

	// Update button states based on position
	const updateScraperVisibility = () => {
		const torrentScrapersSection = document.getElementById('torrentScrapersSection');
		const indexerScrapersSection = document.getElementById('indexerScrapersSection');
		const scrapersSection = document.getElementById('scrapersSection');

		if (!torrentScrapersSection) return;

		// Check if there's at least one debrid service (not Usenet, HomeMedia, Easynews, or httpstreaming)
		const rows = container.querySelectorAll('.service-row');
		let hasDebridService = false;

		rows.forEach(row => {
			const provider = row.querySelector('.debrid-provider')?.value;
			if (provider && provider !== 'Usenet' && provider !== 'HomeMedia' && provider !== 'Easynews' && provider !== 'httpstreaming' && provider !== 'PersonalCloud') {
				hasDebridService = true;
			}
		});

		// Show/hide scrapers based on whether debrid services exist
		if (torrentScrapersSection) {
			torrentScrapersSection.style.display = hasDebridService ? 'block' : 'none';
		}
		if (indexerScrapersSection) {
			indexerScrapersSection.style.display = hasDebridService ? 'block' : 'none';
		}
		if (scrapersSection) {
			scrapersSection.style.display = hasDebridService ? 'block' : 'none';
		}
	};

	const updateButtonStates = () => {
		const rows = container.querySelectorAll('.service-row');
		rows.forEach((row, index) => {
			const moveUpBtn = row.querySelector('.move-up');
			const moveDownBtn = row.querySelector('.move-down');

			// Disable up button if first
			moveUpBtn.disabled = (index === 0);
			// Disable down button if last
			moveDownBtn.disabled = (index === rows.length - 1);
		});

		// Update scraper visibility
		updateScraperVisibility();
	};

	const getDebridServices = () => {
		const services = [];
		const rows = container.querySelectorAll('[data-index]');
		console.log('getDebridServices - Found rows:', rows.length);
		rows.forEach(row => {
			const provider = row.querySelector('.debrid-provider').value;
			const apiKey = row.querySelector('.debrid-apikey').value;
			console.log('Processing provider:', provider);

			if (provider === 'Usenet') {
				const newznabUrl = row.querySelector('.newznab-url')?.value;
				const sabnzbdUrl = row.querySelector('.sabnzbd-url')?.value;
				const sabnzbdApiKey = row.querySelector('.sabnzbd-apikey')?.value;
				const fileServerUrl = row.querySelector('.file-server-url')?.value || '';
				const fileServerPassword = row.querySelector('.file-server-password')?.value || '';
				const deleteOnStreamStop = row.querySelector('.usenet-delete-on-stop')?.checked || false;
				const autoCleanOldFiles = row.querySelector('.usenet-auto-clean')?.checked || false;
				const autoCleanAgeDays = parseInt(row.querySelector('.usenet-clean-age')?.value) || 7;

				if (newznabUrl && apiKey && sabnzbdUrl && sabnzbdApiKey && fileServerUrl) {
					services.push({
						provider: 'Usenet',
						apiKey,
						newznabUrl,
						sabnzbdUrl,
						sabnzbdApiKey,
						fileServerUrl,
						fileServerPassword,
						deleteOnStreamStop,
						autoCleanOldFiles,
						autoCleanAgeDays
					});
				}
			} else if (provider === 'Easynews') {
				const usernameField = row.querySelector('.easynews-username');
				const passwordField = row.querySelector('.debrid-apikey');
				console.log('Easynews username field element:', usernameField);
				console.log('Easynews password field element:', passwordField);

				const username = usernameField?.value;
				const password = passwordField?.value;
				console.log('Easynews field values:', { username, password: password ? '***' : undefined });

				if (username && password) {
					console.log('Adding Easynews service to array');
					services.push({
						provider: 'Easynews',
						username,
						password
					});
				} else {
					console.warn('Easynews fields incomplete - not adding to services', { hasUsername: !!username, hasPassword: !!password });
				}
			} else if (provider === 'HomeMedia') {
				const homeMediaUrl = row.querySelector('.homemedia-url')?.value;

				if (homeMediaUrl) {
					services.push({
						provider: 'HomeMedia',
						apiKey: apiKey || '',  // API key is optional, use empty string if not provided
						homeMediaUrl
					});
				}
			} else if (provider === 'httpstreaming') {
				const http4khdhub = row.querySelector('.http-4khdhub')?.checked ?? true;
				const httpStremsrc = row.querySelector('.http-stremsrc')?.checked ?? true;
				const httpUHDMovies = row.querySelector('.http-uhdmovies')?.checked ?? true;
				const httpMoviesDrive = row.querySelector('.http-moviesdrive')?.checked ?? true;
				const httpHydraflix = row.querySelector('.http-hydraflix')?.checked ?? true;
				services.push({
					provider,
					http4khdhub,
					httpStremsrc,
					httpUHDMovies,
					httpMoviesDrive,
					httpHydraflix
				});
			} else if (provider === 'PersonalCloud') {
				const baseUrl = row.querySelector('.personalcloud-url')?.value || '';
				const newznabUrl = row.querySelector('.personalcloud-newznab-url')?.value || '';
				const newznabApiKey = row.querySelector('.personalcloud-newznab-apikey')?.value || '';

				if (apiKey && baseUrl) {
					services.push({
						provider,
						apiKey,
						baseUrl,
						newznabUrl,
						newznabApiKey
					});
				}
			} else if (provider === 'DebriderApp') {
				const newznabUrl = row.querySelector('.debriderapp-newznab-url')?.value || '';
				const newznabApiKey = row.querySelector('.debriderapp-newznab-apikey')?.value || '';
				const enablePersonalCloud = row.querySelector('.enable-personal-cloud')?.checked ?? true;

				if (apiKey) {
					services.push({
						provider,
						apiKey,
						newznabUrl,
						newznabApiKey,
						enablePersonalCloud
					});
				}
			} else if (provider && apiKey) {
				// Get enablePersonalCloud for standard debrid services
				const enablePersonalCloud = row.querySelector('.enable-personal-cloud')?.checked ?? true;
				services.push({ provider, apiKey, enablePersonalCloud });
			}
		});
		return services;
	};

	const updateLink = () => {
		const formData = new FormData(mainForm);
		const services = getDebridServices();

		const minSize = parseInt(document.getElementById('minSize').value);
		const maxSize = parseInt(document.getElementById('maxSize').value);
		const showCatalog = document.getElementById('ShowCatalog').checked;

		// Get values from Shoelace selects (they return arrays)
		const languages = document.getElementById('Languages').value || [];
		const scrapers = document.getElementById('Scrapers').value || [];
		const indexerScrapers = document.getElementById('IndexerScrapers')?.value || [];

		const config = {
			DebridServices: services,
			Languages: languages,
			Scrapers: scrapers,
			IndexerScrapers: indexerScrapers,
			minSize: minSize,
			maxSize: maxSize,
			ShowCatalog: showCatalog
		};

		// Backward compatibility: if only one non-Usenet service, also set old fields
		const nonUsenetServices = services.filter(s => s.provider !== 'Usenet');
		if (nonUsenetServices.length === 1) {
			config.DebridProvider = nonUsenetServices[0].provider;
			config.DebridApiKey = nonUsenetServices[0].apiKey;
		} else if (nonUsenetServices.length > 1) {
			// Use first non-Usenet service as primary for backwards compatibility
			config.DebridProvider = nonUsenetServices[0].provider;
			config.DebridApiKey = nonUsenetServices[0].apiKey;
		}

		const allValid = services.every(s => {
			if (s.provider === 'Usenet') {
				return s.provider && s.apiKey && s.newznabUrl && s.sabnzbdUrl && s.sabnzbdApiKey && s.fileServerUrl;
			} else if (s.provider === 'Easynews') {
				return s.provider && s.username && s.password;
			} else if (s.provider === 'HomeMedia') {
				return s.provider && s.homeMediaUrl; // API key is optional for Home Media
			} else if (s.provider === 'httpstreaming') {
				return true;
			}
			return s.provider && s.apiKey;
		});

		if (services.length > 0 && allValid) {
			installLink.href = 'stremio://' + window.location.host + '/' + encodeURIComponent(JSON.stringify(config)) + '/manifest.json';
		} else {
			installLink.href = '#';
		}
	};

	// Create debounced version for input events
	const debouncedUpdateLink = debounce(updateLink, 300);

const createServiceRow = (provider = '${process.env.DEFAULT_DEBRID_SERVICE || 'RealDebrid'}', apiKey = '', extraConfig = {}) => {
		const index = serviceIndex++;
		const row = document.createElement('div');
		row.className = 'form-element service-row';
		row.style.cssText = 'display: flex; gap: 1em; align-items: flex-start; margin-bottom: 1em; padding: 1em; background: rgba(35, 53, 84, 0.3); border-radius: 5px;';
		row.dataset.index = index;
		row.draggable = false;

		// Build options with default service first
		const defaultService = '${process.env.DEFAULT_DEBRID_SERVICE || 'RealDebrid'}';
		const allServices = [
			{ value: 'RealDebrid', label: 'Real-Debrid' },
			{ value: 'TorBox', label: 'TorBox' },
			{ value: 'OffCloud', label: 'OffCloud' },
			{ value: 'AllDebrid', label: 'AllDebrid' },
			{ value: 'DebriderApp', label: 'Debrider.app' },
			{ value: 'Premiumize', label: 'Premiumize' },
			{ value: 'Usenet', label: 'Usenet' },
			{ value: 'Easynews', label: 'Easynews' },
			{ value: 'HomeMedia', label: 'Home Media Server' },
			{ value: 'httpstreaming', label: 'HTTP Streaming' }
		];

		// Sort services with default first
		const sortedServices = [
			...allServices.filter(s => s.value === defaultService),
			...allServices.filter(s => s.value !== defaultService)
		];

		const optionsHTML = sortedServices.map(s =>
			\`<option value="\${s.value}">\${s.label}</option>\`
		).join('');

		row.innerHTML = \`
			<div class="reorder-buttons">
				<button type="button" class="reorder-btn move-up" title="Move up">▲</button>
				<button type="button" class="reorder-btn move-down" title="Move down">▼</button>
			</div>
			<div style="flex: 1;">
				<select class="debrid-provider full-width" style="margin-bottom: 0.5em;">
					\${optionsHTML}
				</select>
				<div class="service-config">
					<input type="text" class="debrid-apikey full-width" placeholder="Enter API key" required>
					<div class="api-key-link" style="margin-top: 0.3em; font-size: 0.85rem;"></div>
					<div class="personal-cloud-checkbox" style="margin-top: 0.5em; display: none;">
						<label style="display: flex; align-items: center; font-size: 0.9rem; cursor: pointer;">
							<input type="checkbox" class="enable-personal-cloud" checked style="margin-right: 8px;">
							Enable personal cloud for this service
						</label>
					</div>
				</div>
			</div>
			<button type="button" class="remove-service" style="padding: 0.5em 1em; font-size: 0.9rem; margin-top: 0;">Remove</button>
		\`;

		const select = row.querySelector('.debrid-provider');
		const input = row.querySelector('.debrid-apikey');
		const configDiv = row.querySelector('.service-config');
		const apiKeyLink = row.querySelector('.api-key-link');
		const removeBtn = row.querySelector('.remove-service');
		const personalCloudCheckboxContainer = row.querySelector('.personal-cloud-checkbox');
		const personalCloudCheckbox = row.querySelector('.enable-personal-cloud');

		select.value = provider;
		input.value = apiKey;

		// Set initial checkbox state from extraConfig (default to true)
		if (personalCloudCheckbox) {
			personalCloudCheckbox.checked = extraConfig.enablePersonalCloud !== false;
		}

		// Update API key link based on provider
		const updateApiKeyLink = () => {
			const apiLinks = {
				'RealDebrid': { url: 'https://real-debrid.com/apitoken', label: 'Get Real-Debrid API Key' },
				'TorBox': { url: 'https://torbox.app/settings', label: 'Get TorBox API Key' },
				'AllDebrid': { url: 'https://alldebrid.com/apikeys', label: 'Get AllDebrid API Key' },
				'Premiumize': { url: 'https://www.premiumize.me/account', label: 'Get Premiumize API Key' },
				'OffCloud': { url: 'https://offcloud.com/#/account', label: 'Get OffCloud API Key' },
				'DebriderApp': { url: 'https://debrider.app/dashboard/account', label: 'Get Debrider.app API Key' }
			};

			const providerValue = select.value;
			if (apiLinks[providerValue]) {
				apiKeyLink.innerHTML = \`<a href="\${apiLinks[providerValue].url}" target="_blank" style="color: #64ffda; text-decoration: none;">→ \${apiLinks[providerValue].label}</a>\`;
			} else {
				apiKeyLink.innerHTML = '';
			}
		};

		// Handle provider-specific fields
		const updateUsenetFields = () => {
			// First, clear all provider-specific fields
			const homeMediaUrl = configDiv.querySelector('.homemedia-url');
			const personalCloudUrl = configDiv.querySelector('.personalcloud-url');
			const personalCloudNewznabUrl = configDiv.querySelector('.personalcloud-newznab-url');
			const personalCloudNewznabApiKey = configDiv.querySelector('.personalcloud-newznab-apikey');
			const debriderAppNewznabUrl = configDiv.querySelector('.debriderapp-newznab-url');
			const debriderAppNewznabApiKey = configDiv.querySelector('.debriderapp-newznab-apikey');
			const newznabUrl = configDiv.querySelector('.newznab-url');
			const sabnzbdUrl = configDiv.querySelector('.sabnzbd-url');
			const sabnzbdApiKey = configDiv.querySelector('.sabnzbd-apikey');
			const fileServerUrl = configDiv.querySelector('.file-server-url');
			const fileServerPassword = configDiv.querySelector('.file-server-password');
			const easynewsUsername = configDiv.querySelector('.easynews-username');
			const httpStreamingConfig = configDiv.querySelector('.http-streaming-config');
			const helpText = configDiv.querySelector('small');
			const cleanupOptions = configDiv.querySelector('div[style*="background: rgba(100, 255, 218, 0.05)"]');

			if (homeMediaUrl) homeMediaUrl.remove();
			if (personalCloudUrl) personalCloudUrl.remove();
			if (personalCloudNewznabUrl) personalCloudNewznabUrl.remove();
			if (personalCloudNewznabApiKey) personalCloudNewznabApiKey.remove();
			if (debriderAppNewznabUrl) debriderAppNewznabUrl.remove();
			if (debriderAppNewznabApiKey) debriderAppNewznabApiKey.remove();
			if (newznabUrl) newznabUrl.remove();
			if (sabnzbdUrl) sabnzbdUrl.remove();
			if (sabnzbdApiKey) sabnzbdApiKey.remove();
			if (fileServerUrl) fileServerUrl.remove();
			if (fileServerPassword) fileServerPassword.remove();
			if (easynewsUsername) easynewsUsername.remove();
			if (httpStreamingConfig) httpStreamingConfig.remove();
			if (helpText) helpText.remove();
			if (cleanupOptions) cleanupOptions.remove();

			// Now add fields based on the selected provider
			if (select.value === 'HomeMedia') {
				input.placeholder = 'Home Media API Key (Optional)';

				// Add Home Media URL field
				const homeMediaUrlInput = document.createElement('input');
				homeMediaUrlInput.type = 'text';
				homeMediaUrlInput.className = 'homemedia-url full-width';
				homeMediaUrlInput.placeholder = 'Home Media Server URL (e.g., http://localhost:3003)';
				homeMediaUrlInput.style.marginTop = '0.5em';
				homeMediaUrlInput.value = extraConfig.homeMediaUrl || '';
				configDiv.insertBefore(homeMediaUrlInput, input);
				homeMediaUrlInput.addEventListener('input', debouncedUpdateLink);

				// Add help text with setup link
				const helpText = document.createElement('small');
				helpText.style.color = '#888';
				helpText.style.marginTop = '0.3em';
				helpText.style.display = 'block';
				helpText.innerHTML = 'URL to your personal media file server - <a href="https://github.com/sooti/stremio-addon-debrid-search/tree/main/media-file-server" target="_blank" style="color: #64ffda; text-decoration: underline;">Setup Guide</a>';
				configDiv.appendChild(helpText);
			} else if (select.value === 'PersonalCloud') {
				input.placeholder = 'Personal Cloud API Key';

				// Add Personal Cloud URL field
				const baseUrlInput = document.createElement('input');
				baseUrlInput.type = 'text';
				baseUrlInput.className = 'personalcloud-url full-width';
				baseUrlInput.placeholder = 'Personal Cloud API URL (e.g., https://debrider.app)';
				baseUrlInput.style.marginTop = '0.5em';
				baseUrlInput.value = extraConfig.baseUrl || '';
				configDiv.insertBefore(baseUrlInput, input);
				baseUrlInput.addEventListener('input', debouncedUpdateLink);

				// Add optional Newznab configuration
				const newznabUrlInput = document.createElement('input');
				newznabUrlInput.type = 'text';
				newznabUrlInput.className = 'personalcloud-newznab-url full-width';
				newznabUrlInput.placeholder = 'Newznab URL (Optional - e.g., https://api.nzbgeek.info)';
				newznabUrlInput.style.marginTop = '0.5em';
				newznabUrlInput.value = extraConfig.newznabUrl || '';
				configDiv.appendChild(newznabUrlInput);
				newznabUrlInput.addEventListener('input', debouncedUpdateLink);

				const newznabApiKeyInput = document.createElement('input');
				newznabApiKeyInput.type = 'text';
				newznabApiKeyInput.className = 'personalcloud-newznab-apikey full-width';
				newznabApiKeyInput.placeholder = 'Newznab API Key (Optional)';
				newznabApiKeyInput.style.marginTop = '0.5em';
				newznabApiKeyInput.value = extraConfig.newznabApiKey || '';
				configDiv.appendChild(newznabApiKeyInput);
				newznabApiKeyInput.addEventListener('input', debouncedUpdateLink);

				// Add help text
				const helpText = document.createElement('small');
				helpText.style.color = '#888';
				helpText.style.marginTop = '0.3em';
				helpText.style.display = 'block';
				helpText.innerHTML = 'Personal Cloud checks your tasks and files. Optional: Add Newznab for NZB support.';
				configDiv.appendChild(helpText);
			} else if (select.value === 'Usenet') {
				input.placeholder = 'Newznab API Key';

				// Add additional Usenet fields
				const newznabUrlInput = document.createElement('input');
				newznabUrlInput.type = 'text';
				newznabUrlInput.className = 'newznab-url full-width';
				newznabUrlInput.placeholder = 'Newznab URL (e.g., https://api.nzbgeek.info)';
				newznabUrlInput.style.marginTop = '0.5em';
				newznabUrlInput.value = extraConfig.newznabUrl || '';
				configDiv.insertBefore(newznabUrlInput, input);
				newznabUrlInput.addEventListener('input', debouncedUpdateLink);

				const sabnzbdUrlInput = document.createElement('input');
				sabnzbdUrlInput.type = 'text';
				sabnzbdUrlInput.className = 'sabnzbd-url full-width';
				sabnzbdUrlInput.placeholder = 'SABnzbd URL (e.g., localhost:8080 or http://ip:port)';
				sabnzbdUrlInput.style.marginTop = '0.5em';
				sabnzbdUrlInput.value = extraConfig.sabnzbdUrl || '';
				configDiv.appendChild(sabnzbdUrlInput);
				sabnzbdUrlInput.addEventListener('input', debouncedUpdateLink);

				const sabnzbdApiInput = document.createElement('input');
				sabnzbdApiInput.type = 'text';
				sabnzbdApiInput.className = 'sabnzbd-apikey full-width';
				sabnzbdApiInput.placeholder = 'SABnzbd API Key';
				sabnzbdApiInput.style.marginTop = '0.5em';
				sabnzbdApiInput.value = extraConfig.sabnzbdApiKey || '';
				configDiv.appendChild(sabnzbdApiInput);
				sabnzbdApiInput.addEventListener('input', debouncedUpdateLink);

				const fileServerInput = document.createElement('input');
				fileServerInput.type = 'text';
				fileServerInput.className = 'file-server-url full-width';
				fileServerInput.placeholder = 'File Server URL (Required - e.g., http://localhost:8081)';
				fileServerInput.style.marginTop = '0.5em';
				fileServerInput.value = extraConfig.fileServerUrl || '';
				configDiv.appendChild(fileServerInput);
				fileServerInput.addEventListener('input', debouncedUpdateLink);

				// Add file server password field
				const fileServerPasswordInput = document.createElement('input');
				fileServerPasswordInput.type = 'text';
				fileServerPasswordInput.className = 'file-server-password full-width';
				fileServerPasswordInput.placeholder = 'File Server Password (Optional - leave empty if not set)';
				fileServerPasswordInput.style.marginTop = '0.5em';
				fileServerPasswordInput.value = extraConfig.fileServerPassword || '';
				configDiv.appendChild(fileServerPasswordInput);
				fileServerPasswordInput.addEventListener('input', debouncedUpdateLink);

				// Add help text with setup link
				const helpText = document.createElement('small');
				helpText.style.color = '#888';
				helpText.style.marginTop = '0.3em';
				helpText.style.display = 'block';
				helpText.innerHTML = 'Required: File server for direct streaming - <a href="https://github.com/sooti/stremio-addon-debrid-search/tree/main/media-file-server" target="_blank" style="color: #64ffda; text-decoration: underline;">Setup Guide</a>';
				configDiv.appendChild(helpText);

				// Add cleanup options
				const cleanupOptionsDiv = document.createElement('div');
				cleanupOptionsDiv.style.cssText = 'margin-top: 1em; padding: 0.8em; background: rgba(100, 255, 218, 0.05); border-radius: 5px; border: 1px solid rgba(100, 255, 218, 0.2);';
				cleanupOptionsDiv.innerHTML = \`
					<div style="font-weight: 600; margin-bottom: 0.5em; color: #64ffda; font-size: 0.9rem;">Cleanup Options</div>
					<div style="display: flex; align-items: center; margin-bottom: 0.5em;">
						<input type="checkbox" class="usenet-delete-on-stop" id="usenet-delete-on-stop-\${index}" style="margin-right: 8px;">
						<label for="usenet-delete-on-stop-\${index}" style="font-size: 0.9rem; cursor: pointer;">Delete file when stream stops (saves space)</label>
					</div>
					<div style="display: flex; align-items: center; margin-bottom: 0.5em;">
						<input type="checkbox" class="usenet-auto-clean" id="usenet-auto-clean-\${index}" style="margin-right: 8px;">
						<label for="usenet-auto-clean-\${index}" style="font-size: 0.9rem; cursor: pointer;">Auto-clean old files</label>
					</div>
					<div style="display: flex; align-items: center; margin-left: 1.5em;">
						<label for="usenet-clean-age-\${index}" style="font-size: 0.85rem; margin-right: 0.5em;">Age (days):</label>
						<input type="number" class="usenet-clean-age" id="usenet-clean-age-\${index}" min="1" max="365" value="7" style="width: 80px; padding: 0.4em; background: #112240; border: 1px solid #233554; color: #ccd6f6; border-radius: 3px;">
					</div>
				\`;
				configDiv.appendChild(cleanupOptionsDiv);

				// Set values from extraConfig
				const deleteOnStopCheckbox = cleanupOptionsDiv.querySelector('.usenet-delete-on-stop');
				const autoCleanCheckbox = cleanupOptionsDiv.querySelector('.usenet-auto-clean');
				const cleanAgeInput = cleanupOptionsDiv.querySelector('.usenet-clean-age');

				if (extraConfig.deleteOnStreamStop) deleteOnStopCheckbox.checked = true;
				if (extraConfig.autoCleanOldFiles) autoCleanCheckbox.checked = true;
				if (extraConfig.autoCleanAgeDays) cleanAgeInput.value = extraConfig.autoCleanAgeDays;

				// Add change listeners
				deleteOnStopCheckbox.addEventListener('change', debouncedUpdateLink);
				autoCleanCheckbox.addEventListener('change', debouncedUpdateLink);
				cleanAgeInput.addEventListener('input', debouncedUpdateLink);
			} else if (select.value === 'Easynews') {
				input.placeholder = 'Easynews Password';
				input.required = false; // Make it optional for now to test
				input.removeAttribute('required');
				// Preserve existing password if extraConfig has it
				if (extraConfig.password) {
					input.value = extraConfig.password;
				}

				// Add Easynews username field
				const usernameInput = document.createElement('input');
				usernameInput.type = 'text';
				usernameInput.className = 'easynews-username full-width';
				usernameInput.placeholder = 'Easynews Username';
				usernameInput.style.marginTop = '0.5em';
				usernameInput.value = extraConfig.username || '';
				usernameInput.required = false; // Make it optional for now to test
				configDiv.insertBefore(usernameInput, input);
				usernameInput.addEventListener('input', debouncedUpdateLink);

				// Add help text
				const helpText = document.createElement('small');
				helpText.style.color = '#888';
				helpText.style.marginTop = '0.3em';
				helpText.style.display = 'block';
				helpText.innerHTML = 'Enter your Easynews credentials - <a href="https://easynews.com" target="_blank" style="color: #64ffda; text-decoration: underline;">Get Easynews Account</a>';
				configDiv.appendChild(helpText);
			} else if (select.value === 'httpstreaming') {
				input.style.display = 'none';
				// Add HTTP Streaming configuration
				const httpConfigDiv = document.createElement('div');
				httpConfigDiv.className = 'http-streaming-config';
				httpConfigDiv.style.cssText = 'margin-top: 1em; padding: 0.8em; background: rgba(100, 255, 218, 0.05); border-radius: 5px; border: 1px solid rgba(100, 255, 218, 0.2);';
				httpConfigDiv.innerHTML = \`<div style=\"font-weight: 600; margin-bottom: 0.5em; color: #64ffda; font-size: 0.9rem;\">HTTP Streaming Sources</div><div style=\"display: flex; flex-direction: column; gap: 0.5em;\"><label style=\"display: flex; align-items: center; font-size: 0.9rem; cursor: pointer;\"><input type=\"checkbox\" class=\"http-4khdhub\" checked style=\"margin-right: 8px;">4KHDHub</label><label style=\"display: flex; align-items: center; font-size: 0.9rem; cursor: pointer;\"><input type=\"checkbox\" class=\"http-uhdmovies\" checked style=\"margin-right: 8px;">UHDMovies</label><label style=\"display: flex; align-items: center; font-size: 0.9rem; cursor: pointer;\"><input type=\"checkbox\" class=\"http-moviesdrive\" checked style=\"margin-right: 8px;">MoviesDrive</label><label style=\"display: flex; align-items: center; font-size: 0.9rem; cursor: pointer;\"><input type=\"checkbox\" class=\"http-stremsrc\" checked style=\"margin-right: 8px;">stremsrc</label><label style="display: flex; align-items: center; font-size: 0.9rem; cursor: pointer;"><input type="checkbox" class="http-hydraflix" checked style="margin-right: 8px;">Hydraflix</label></div>\`;
				configDiv.appendChild(httpConfigDiv);
				// Add event listeners to update link when checkboxes change
				httpConfigDiv.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
					checkbox.addEventListener('change', debouncedUpdateLink);
				});
			} else if (select.value === 'DebriderApp') {
				input.placeholder = 'Debrider.app API Key';

				// Add optional Newznab configuration for Personal Cloud support
				const newznabUrlInput = document.createElement('input');
				newznabUrlInput.type = 'text';
				newznabUrlInput.className = 'debriderapp-newznab-url full-width';
				newznabUrlInput.placeholder = 'Newznab URL (Optional - for Personal Cloud NZB support)';
				newznabUrlInput.style.marginTop = '0.5em';
				newznabUrlInput.value = extraConfig.newznabUrl || '';
				configDiv.appendChild(newznabUrlInput);
				newznabUrlInput.addEventListener('input', debouncedUpdateLink);

				const newznabApiKeyInput = document.createElement('input');
				newznabApiKeyInput.type = 'text';
				newznabApiKeyInput.className = 'debriderapp-newznab-apikey full-width';
				newznabApiKeyInput.placeholder = 'Newznab API Key (Optional)';
				newznabApiKeyInput.style.marginTop = '0.5em';
				newznabApiKeyInput.value = extraConfig.newznabApiKey || '';
				configDiv.appendChild(newznabApiKeyInput);
				newznabApiKeyInput.addEventListener('input', debouncedUpdateLink);

				// Add help text
				const helpText = document.createElement('small');
				helpText.style.color = '#888';
				helpText.style.marginTop = '0.3em';
				helpText.style.display = 'block';
				helpText.innerHTML = 'Optional: Configure Newznab to enable Personal Cloud NZB task creation';
				configDiv.appendChild(helpText);
			} else {
				input.placeholder = 'Enter API key';
				input.style.display = '';
				input.type = 'text';
			}

			// Show/hide personal cloud checkbox based on provider
			// Services that support personal cloud: RealDebrid, AllDebrid, TorBox, OffCloud, DebriderApp
			const personalCloudSupportedProviders = ['RealDebrid', 'AllDebrid', 'TorBox', 'OffCloud', 'DebriderApp'];
			if (personalCloudCheckboxContainer) {
				if (personalCloudSupportedProviders.includes(select.value)) {
					personalCloudCheckboxContainer.style.display = 'block';
				} else {
					personalCloudCheckboxContainer.style.display = 'none';
				}
			}
		};

		updateUsenetFields();
		updateApiKeyLink();

		select.addEventListener('change', () => {
			updateUsenetFields();
			updateApiKeyLink();
			updateScraperVisibility();
			updateLink();
		});
		input.addEventListener('input', debouncedUpdateLink);

		// Add event listener for personal cloud checkbox
		if (personalCloudCheckbox) {
			personalCloudCheckbox.addEventListener('change', debouncedUpdateLink);
		}

		removeBtn.addEventListener('click', () => {
			row.remove();
			updateButtonStates();
			updateLink();
		});

		// Arrow button handlers
		const moveUpBtn = row.querySelector('.move-up');
		const moveDownBtn = row.querySelector('.move-down');

		moveUpBtn.addEventListener('click', () => {
			const previousRow = row.previousElementSibling;
			if (previousRow) {
				container.insertBefore(row, previousRow);
				updateButtonStates();
				updateLink();
			}
		});

		moveDownBtn.addEventListener('click', () => {
			const nextRow = row.nextElementSibling;
			if (nextRow) {
				container.insertBefore(nextRow, row);
				updateButtonStates();
				updateLink();
			}
		});

		container.appendChild(row);
		return row;
	};

	// Initialize services
	existingServices.forEach(service => {
		let extraConfig = {};
		if (service.provider === 'Usenet') {
			extraConfig = {
				newznabUrl: service.newznabUrl || '',
				sabnzbdUrl: service.sabnzbdUrl || '',
				sabnzbdApiKey: service.sabnzbdApiKey || '',
				fileServerUrl: service.fileServerUrl || '',
				fileServerPassword: service.fileServerPassword || '',
				deleteOnStreamStop: service.deleteOnStreamStop || false,
				autoCleanOldFiles: service.autoCleanOldFiles || false,
				autoCleanAgeDays: service.autoCleanAgeDays || 7
			};
		} else if (service.provider === 'Easynews') {
			extraConfig = {
				username: service.username || '',
				password: service.password || ''
			};
		} else if (service.provider === 'HomeMedia') {
			extraConfig = {
				homeMediaUrl: service.homeMediaUrl || ''
			};
		} else if (service.provider === 'DebriderApp') {
			extraConfig = {
				newznabUrl: service.newznabUrl || '',
				newznabApiKey: service.newznabApiKey || '',
				enablePersonalCloud: service.enablePersonalCloud
			};
		} else if (service.provider === 'PersonalCloud') {
			extraConfig = {
				baseUrl: service.baseUrl || '',
				newznabUrl: service.newznabUrl || '',
				newznabApiKey: service.newznabApiKey || ''
			};
		} else {
			// For standard debrid services (RealDebrid, AllDebrid, TorBox, etc.)
			extraConfig = {
				enablePersonalCloud: service.enablePersonalCloud
			};
		}
		// For Easynews, pass password as apiKey parameter so it gets set in the input field
		const apiKeyValue = service.provider === 'Easynews' ? (service.password || '') : (service.apiKey || '');
		createServiceRow(service.provider, apiKeyValue, extraConfig);
	});

	// Update button states after initialization
	updateButtonStates();
	// Update install link with initial service configuration
	updateLink();

	addServiceBtn.addEventListener('click', () => {
		createServiceRow();
		updateButtonStates();
		updateLink();
	});

	// Wait for Shoelace components to be ready
	Promise.all([
		customElements.whenDefined('sl-select'),
		customElements.whenDefined('sl-option')
	]).then(() => {
		// Initialize language selection
		const languages = ${JSON.stringify(config.Languages) || '[]'};
		const languagesSelectInit = document.getElementById('Languages');
		if (languagesSelectInit && languages.length > 0) {
			languagesSelectInit.value = languages;
		}
		// Add event listener for language changes
		languagesSelectInit.addEventListener('sl-change', () => {
			updateLink();
		});

		// Initialize scraper selection
		const scrapers = ${JSON.stringify(config.Scrapers) || '[]'};
		if (scrapers && scrapers.length > 0) {
			scrapersSelect.value = scrapers;
		}
		scrapersSelect.addEventListener('sl-change', () => {
			updateLink();
		});

		// Initialize indexer scraper selection (only if the element exists)
		if (indexerScrapersSelect) {
			const indexerScrapers = ${JSON.stringify(config.IndexerScrapers) || '[]'};

			// If no indexer scrapers were previously selected (empty config), enable defaults if available
			if (indexerScrapers.length > 0) {
				indexerScrapersSelect.value = indexerScrapers;
			} else {
				// Select default indexer scrapers if they are enabled
				const defaults = [];
				const zileanOption = indexerScrapersSelect.querySelector('sl-option[value="zilean"]');
				const stremthruOption = indexerScrapersSelect.querySelector('sl-option[value="stremthru"]');

				if (zileanOption) defaults.push('zilean');
				if (stremthruOption) defaults.push('stremthru');

				if (defaults.length > 0) {
					indexerScrapersSelect.value = defaults;
				}
			}

			indexerScrapersSelect.addEventListener('sl-change', () => {
				updateLink();
			});
		}
	});

	// Initialize size sliders
	const minSizeSlider = document.getElementById('minSize');
	const maxSizeSlider = document.getElementById('maxSize');
	const minSizeLabel = document.getElementById('minSizeLabel');
	const maxSizeLabel = document.getElementById('maxSizeLabel');

	if (minSizeSlider && maxSizeSlider && minSizeLabel && maxSizeLabel) {
		// Set initial values from config
		const initialMinSize = ${config.minSize || 0};
		const initialMaxSize = ${config.maxSize || 200};
		minSizeSlider.value = initialMinSize;
		maxSizeSlider.value = initialMaxSize;
		minSizeLabel.textContent = initialMinSize + ' GB';
		maxSizeLabel.textContent = initialMaxSize + ' GB';

		// Update labels when sliders change
		const updateMinLabel = function() {
			let minVal = parseInt(minSizeSlider.value);
			let maxVal = parseInt(maxSizeSlider.value);
			if (minVal > maxVal) {
				minSizeSlider.value = maxVal;
				minVal = maxVal;
			}
			minSizeLabel.textContent = minVal + ' GB';
			updateLink();
		};

		const updateMaxLabel = function() {
			let minVal = parseInt(minSizeSlider.value);
			let maxVal = parseInt(maxSizeSlider.value);
			if (maxVal < minVal) {
				maxSizeSlider.value = minVal;
				maxVal = minVal;
			}
			maxSizeLabel.textContent = maxVal + ' GB';
			updateLink();
		};

		minSizeSlider.addEventListener('input', updateMinLabel);
		minSizeSlider.addEventListener('change', updateMinLabel);
		maxSizeSlider.addEventListener('input', updateMaxLabel);
		maxSizeSlider.addEventListener('change', updateMaxLabel);
	} else {
		console.error('Size slider elements not found:', {
			minSizeSlider: !!minSizeSlider,
			maxSizeSlider: !!maxSizeSlider,
			minSizeLabel: !!minSizeLabel,
			maxSizeLabel: !!maxSizeLabel
		});
	}

	// Initialize ShowCatalog checkbox from config (default to true)
	const showCatalogCheckbox = document.getElementById('ShowCatalog');
	if (showCatalogCheckbox) {
		showCatalogCheckbox.checked = ${config.ShowCatalog !== false}; // Default to true unless explicitly false
		showCatalogCheckbox.addEventListener('change', debouncedUpdateLink);
	}

	installLink.onclick = (event) => {
		const services = getDebridServices();
		console.log('Install clicked - Services:', services);
		const allValid = services.every(s => {
			if (s.provider === 'Usenet') {
				return s.provider && s.apiKey && s.newznabUrl && s.sabnzbdUrl && s.sabnzbdApiKey && s.fileServerUrl;
			} else if (s.provider === 'Easynews') {
				const valid = !!(s.provider && s.username && s.password);
				console.log('Easynews validation:', { provider: s.provider, username: s.username, password: s.password ? '***' : undefined, valid });
				return valid;
			} else if (s.provider === 'HomeMedia') {
				return s.provider && s.homeMediaUrl; // API key is optional for Home Media
			} else if (s.provider === 'PersonalCloud') {
				return s.provider && s.apiKey && s.baseUrl; // Newznab is optional
			} else if (s.provider === 'httpstreaming') {
				return true;
			}
			return s.provider && s.apiKey;
		});

		console.log('All valid:', allValid);
		console.log('Install link href:', installLink.href);

		if (services.length === 0 || !allValid) {
			event.preventDefault();
			alert('Please complete all required fields for your services.');
		} else {
			console.log('Install link is valid, should open Stremio...');
		}
	}

	const copyLinkBtn = document.getElementById('copyLinkBtn');
	const toast = document.getElementById('toast');

	const showToast = () => {
		if (toast) {
			toast.classList.add('show');
			setTimeout(() => {
				toast.classList.remove('show');
			}, 2000);
		}
	};

	if (copyLinkBtn) {
		copyLinkBtn.onclick = (e) => {
			e.preventDefault();

			const services = getDebridServices();
			const allValid = services.every(s => {
				if (s.provider === 'Usenet') {
					return s.provider && s.apiKey && s.newznabUrl && s.sabnzbdUrl && s.sabnzbdApiKey && s.fileServerUrl;
				} else if (s.provider === 'Easynews') {
					return s.provider && s.username && s.password;
				} else if (s.provider === 'HomeMedia') {
					return s.provider && s.homeMediaUrl; // API key is optional for Home Media
				} else if (s.provider === 'PersonalCloud') {
					return s.provider && s.apiKey && s.baseUrl; // Newznab is optional
				} else if (s.provider === 'httpstreaming') {
					return true;
				}
				return s.provider && s.apiKey;
			});

			if (services.length === 0 || !allValid) {
				alert('Please complete all required fields for your services.');
				return;
			}

			const manifestUrl = installLink.href.replace('stremio://', 'https://');

			// Try modern clipboard API first, with better mobile support
			const copyToClipboard = (text) => {
				// Try modern clipboard API
				if (navigator.clipboard && window.isSecureContext) {
					return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
				}

				// Fallback for mobile and older browsers
				const textArea = document.createElement('textarea');
				textArea.value = text;
				textArea.style.position = 'fixed';
				textArea.style.top = '0';
				textArea.style.left = '0';
				textArea.style.width = '2em';
				textArea.style.height = '2em';
				textArea.style.padding = '0';
				textArea.style.border = 'none';
				textArea.style.outline = 'none';
				textArea.style.boxShadow = 'none';
				textArea.style.background = 'transparent';
				textArea.setAttribute('readonly', '');
				document.body.appendChild(textArea);

				// Mobile Safari requires contentEditable
				textArea.contentEditable = true;
				textArea.readOnly = false;

				// Select text
				const range = document.createRange();
				range.selectNodeContents(textArea);
				const selection = window.getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
				textArea.setSelectionRange(0, text.length);

				let success = false;
				try {
					success = document.execCommand('copy');
				} catch (err) {
					// Silent fail, will show alert fallback
				}

				document.body.removeChild(textArea);
				return Promise.resolve(success);
			};

			copyToClipboard(manifestUrl).then(success => {
				if (success) {
					showToast();
				} else {
					alert('Copied to clipboard: ' + manifestUrl);
				}
			});
		};
	}

	mainForm.oninput = debouncedUpdateLink;
	updateLink();

	// Wizard navigation for mobile
	const wizardPage1 = document.getElementById('wizardPage1');
	const wizardPage2 = document.getElementById('wizardPage2');
	const wizardPage3 = document.getElementById('wizardPage3');
	const nextToPage2Btn = document.getElementById('nextToPage2');
	const nextToPage3Btn = document.getElementById('nextToPage3');
	const backToPage1Btn = document.getElementById('backToPage1');
	const backToPage2Btn = document.getElementById('backToPage2');
	const installButtons = document.getElementById('installButtons');

	if (nextToPage2Btn) {
		nextToPage2Btn.addEventListener('click', () => {
			// Validate at least one service is added
			const services = getDebridServices();
			if (services.length === 0) {
				alert('Please add at least one service before continuing.');
				return;
			}

			// Check if services are valid
			const allValid = services.every(s => {
				if (s.provider === 'Usenet') {
					return s.provider && s.apiKey && s.newznabUrl && s.sabnzbdUrl && s.sabnzbdApiKey && s.fileServerUrl;
				} else if (s.provider === 'Easynews') {
					return s.provider && s.username && s.password;
				} else if (s.provider === 'HomeMedia') {
					return s.provider && s.homeMediaUrl;
				} else if (s.provider === 'PersonalCloud') {
					return s.provider && s.apiKey && s.baseUrl;
				} else if (s.provider === 'httpstreaming') {
					return true;
				}
				return s.provider && s.apiKey;
			});

			if (!allValid) {
				alert('Please complete all required fields for your services.');
				return;
			}

			// Navigate to page 2
			wizardPage1.style.display = 'none';
			wizardPage2.style.display = 'block';
			// Update scraper visibility when entering page 2
			updateScraperVisibility();
			window.scrollTo({ top: 0, behavior: 'smooth' });
		});
	}

	if (nextToPage3Btn) {
		nextToPage3Btn.addEventListener('click', () => {
			// Navigate to page 3
			wizardPage2.style.display = 'none';
			wizardPage3.style.display = 'block';
			if (installButtons) {
				installButtons.classList.add('visible');
			}
			window.scrollTo({ top: 0, behavior: 'smooth' });
		});
	}

	if (backToPage1Btn) {
		backToPage1Btn.addEventListener('click', () => {
			wizardPage2.style.display = 'none';
			wizardPage1.style.display = 'block';
			window.scrollTo({ top: 0, behavior: 'smooth' });
		});
	}

	if (backToPage2Btn) {
		backToPage2Btn.addEventListener('click', () => {
			wizardPage3.style.display = 'none';
			wizardPage2.style.display = 'block';
			if (installButtons) {
				installButtons.classList.remove('visible');
			}
			window.scrollTo({ top: 0, behavior: 'smooth' });
		});
	}
	`

    return `
	<!DOCTYPE html>
	<html class="sl-theme-dark" style="background-image: url(${background});">

	<head>
		<meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${manifest.name} | Stremio Addon</title>
		<style>${STYLESHEET}</style>
		<link rel="shortcut icon" href="${logo}" type="image/x-icon">
		<link href="https://fonts.googleapis.com/css?family=Open+Sans:400,600,700&display=swap" rel="stylesheet">
		<!-- Shoelace for better dropdowns -->
		<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.20.1/cdn/themes/dark.css" />
		<script type="module" src="https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.20.1/cdn/shoelace-autoloader.js"></script>
	</head>

<body>

<div id="addon">
<div class="logo">
    <img src="${logo}">
</div>
<h1 class="name">${manifest.name}</h1>
<h2 class="version">v${manifest.version || '0.0.0'} | ${manifest.description || ''}</h2>

${customDescriptionBlurb ? `<div style="margin: 0.5em 0; padding: 0.75em 1em; background: rgba(15, 30, 50, 0.8); border-radius: 8px; width: 100%; margin-left: auto; margin-right: auto; backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);">${customDescriptionBlurb}</div>` : ''}

            <hr class="separator">

			${formHTML}

            <p style="text-align: center; margin-top: 2em; opacity: 0.7;">Report any issues on <a href="https://github.com/sooti/stremio-addon-debrid-search" target="_blank">Github</a></p>

			${contactHTML}
		</div>
		<script>
			${script}

			if (typeof updateLink === 'function')
			    updateLink();
			else
			    installLink.href = 'stremio://' + window.location.host + '/manifest.json';
		</script>
	</body>

	</html>`
}

export default landingTemplate
