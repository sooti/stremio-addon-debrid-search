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
    display: flex;
    align-items: center;
    justify-content: center;
	font-family: 'Open Sans', Arial, sans-serif;
	color: #ccd6f6;
    line-height: 1.5;
    padding: 1em; /* Add some padding for small screens */
}

#addon {
    width: 90%; /* Use percentage for responsive width */
    max-width: 700px; /* Max width for larger screens */
    margin: auto;
    padding: 2em 3em;
    background: rgba(10, 25, 47, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 15px;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
}

.logo {
	height: 100px;
	width: 100px;
	margin: 0 auto 1.5em;
}

.logo img {
	width: 100%;
}

h1 {
	font-size: 2.5rem;
	font-weight: 700;
    text-align: center;
    color: #fff;
}

h2 {
	font-size: 1.1rem;
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
}
`

function landingTemplate(manifest, config) {
    const background = 'https://images.unsplash.com/photo-1534796636912-3b95b3ab5986?q=80&w=2071&auto=format&fit=crop&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D';
    const logo = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%2364ffda;stop-opacity:1' /%3E%3Cstop offset='100%25' style='stop-color:%2300A7B5;stop-opacity:1' /%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath fill='url(%23grad)' d='M50,5 C74.85,5 95,25.15 95,50 C95,74.85 74.85,95 50,95 C35,95 22.33,87.6 15,76 C25,85 40,85 50,80 C60,75 65,65 65,50 C65,35 55,25 40,25 C25,25 15,40 15,50 C15,55 16,60 18,64 C8.5,58 5,45 5,50 C5,25.15 25.15,5 50,5 Z'/%3E%3C/svg%3E";
    const contactHTML = manifest.contactEmail ?
        `<div class="contact">
            <p>Contact ${manifest.name} creator:</p>
            <a href="mailto:${manifest.contactEmail}">${manifest.contactEmail}</a>
        </div>` : ''

    let formHTML = ''
    let script = ''

	formHTML = `
	<form class="pure-form" id="mainForm">
		<div class="form-element">
			<label class="label-to-top">Debrid & Usenet Services</label>
			<p style="opacity: 0.7; font-size: 0.9rem; margin-bottom: 1em;">Add one or more services. All services will be queried simultaneously.</p>
			<div id="debridServicesContainer"></div>
			<button type="button" id="addServiceBtn" style="margin: 1em 0; padding: 0.5em 1em; font-size: 0.9rem;">+ Add Service</button>
		</div>

		<hr class="separator">

		<div class="form-element">
			<label class="label-to-top" for="Languages">Filter by Languages (optional)</label>
			<select id="Languages" name="Languages" class="full-width" multiple>
				<option value="en">🇬🇧 English</option>
				<option value="fr">🇫🇷 French</option>
				<option value="es">🇪🇸 Spanish</option>
				<option value="de">🇩🇪 German</option>
				<option value="it">🇮🇹 Italian</option>
				<option value="pt">🇵🇹 Portuguese</option>
				<option value="ru">🇷🇺 Russian</option>
				<option value="hi">🇮🇳 Hindi</option>
				<option value="ja">🇯🇵 Japanese</option>
				<option value="ko">🇰🇷 Korean</option>
				<option value="zh">🇨🇳 Chinese</option>
				<option value="ar">🇦🇪 Arabic</option>
				<option value="tr">🇹🇷 Turkish</option>
				<option value="nl">🇳🇱 Dutch</option>
				<option value="sv">🇸🇪 Swedish</option>
				<option value="no">🇳🇴 Norwegian</option>
				<option value="da">🇩🇰 Danish</option>
				<option value="fi">🇫🇮 Finnish</option>
				<option value="pl">🇵🇱 Polish</option>
				<option value="cs">🇨🇿 Czech</option>
				<option value="hu">🇭🇺 Hungarian</option>
				<option value="ro">🇷🇴 Romanian</option>
				<option value="el">🇬🇷 Greek</option>
				<option value="he">🇮🇱 Hebrew</option>
				<option value="th">🇹🇭 Thai</option>
				<option value="ta">🇮🇳 Tamil</option>
				<option value="ml">🇮🇳 Malayalam</option>
				<option value="te">🇮🇳 Telugu</option>
				<option value="kn">🇮🇳 Kannada</option>
				<option value="es-419">🇲🇽 Latino</option>
			</select>
			<p style="opacity: 0.7; font-size: 0.9rem; margin-top: 0.5em;">Select one or more languages. If none are selected, no language filter is applied. Selecting English keeps English or unlabeled.</p>
		</div>

		<div class="form-element">
			<label class="label-to-top">Filter by File Size (optional)</label>
			<div style="margin-bottom: 1em;">
				<div style="display: flex; justify-content: space-between; margin-bottom: 0.5em;">
					<span style="font-size: 0.9rem;">Min: <span id="minSizeLabel">0 GB</span></span>
					<span style="font-size: 0.9rem;">Max: <span id="maxSizeLabel">200 GB</span></span>
				</div>
				<div style="display: flex; gap: 1em; align-items: center;">
					<input type="range" id="minSize" name="minSize" min="0" max="200" value="0" step="1" class="full-width" style="flex: 1;">
					<input type="range" id="maxSize" name="maxSize" min="0" max="200" value="200" step="1" class="full-width" style="flex: 1;">
				</div>
			</div>
			<p style="opacity: 0.7; font-size: 0.9rem;">Filter streams by file size. Drag sliders to set min/max size in GB. Set to 0-200 for no filtering.</p>
		</div>

<!--		<div class="form-element checkbox-container">
			<input type="checkbox" id="ShowCatalog" name="ShowCatalog" value="true">
            <label for="ShowCatalog">Show Debrid Catalog on homepage</label>
		</div> -->
	</form>
	`

	script += `
	const mainForm = document.getElementById('mainForm');
	const installLink = document.getElementById('installLink');
	const container = document.getElementById('debridServicesContainer');
	const addServiceBtn = document.getElementById('addServiceBtn');
	const usenetEnabled = document.getElementById('UsenetEnabled');
	const usenetConfig = document.getElementById('usenetConfig');

	let serviceIndex = 0;

	// Initialize with existing config or one empty service
	const existingServices = ${JSON.stringify(config.DebridServices || (config.DebridProvider ? [{ provider: config.DebridProvider, apiKey: config.DebridApiKey }] : [{ provider: 'RealDebrid', apiKey: '' }]))};

	const getDebridServices = () => {
		const services = [];
		const rows = container.querySelectorAll('[data-index]');
		rows.forEach(row => {
			const provider = row.querySelector('.debrid-provider').value;
			const apiKey = row.querySelector('.debrid-apikey').value;

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
				const httpUHDMovies = row.querySelector('.http-uhdmovies')?.checked ?? true;
				services.push({
					provider,
					http4khdhub,
					httpUHDMovies
				});
			} else if (provider && apiKey) {
				services.push({ provider, apiKey });
			}
		});
		return services;
	};

	const updateLink = () => {
		const formData = new FormData(mainForm);
		const services = getDebridServices();

		const minSize = parseInt(document.getElementById('minSize').value);
		const maxSize = parseInt(document.getElementById('maxSize').value);

		const config = {
			DebridServices: services,
			Languages: formData.getAll('Languages'),
			minSize: minSize,
			maxSize: maxSize
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

	const createServiceRow = (provider = 'RealDebrid', apiKey = '', extraConfig = {}) => {
		const index = serviceIndex++;
		const row = document.createElement('div');
		row.className = 'form-element';
		row.style.cssText = 'display: flex; gap: 1em; align-items: flex-start; margin-bottom: 1em; padding: 1em; background: rgba(35, 53, 84, 0.3); border-radius: 5px;';
		row.dataset.index = index;

		row.innerHTML = \`
			<div style="flex: 1;">
				<select class="debrid-provider full-width" style="margin-bottom: 0.5em;">
					<option value="RealDebrid">Real-Debrid</option>
					<option value="TorBox">TorBox</option>
					<option value="OffCloud">OffCloud</option>
					<option value="AllDebrid">AllDebrid</option>
					<option value="DebriderApp">Debrider.app</option>
					<option value="Premiumize">Premiumize</option>
					<option value="Usenet">Usenet</option>
					<option value="HomeMedia">Home Media Server</option>
					<option value="httpstreaming">HTTP Streaming</option>
				</select>
				<div class="service-config">
					<input type="text" class="debrid-apikey full-width" placeholder="Enter API key" required>
				</div>
			</div>
			<button type="button" class="remove-service" style="padding: 0.5em 1em; font-size: 0.9rem; margin-top: 0;">Remove</button>
		\`;

		const select = row.querySelector('.debrid-provider');
		const input = row.querySelector('.debrid-apikey');
		const configDiv = row.querySelector('.service-config');
		const removeBtn = row.querySelector('.remove-service');

		select.value = provider;
		input.value = apiKey;

		// Handle provider-specific fields
		const updateUsenetFields = () => {
			if (select.value === 'HomeMedia') {
				input.placeholder = 'Home Media API Key (Optional)';

				// Add Home Media URL field if it doesn't exist
				if (!configDiv.querySelector('.homemedia-url')) {
					const homeMediaUrlInput = document.createElement('input');
					homeMediaUrlInput.type = 'text';
					homeMediaUrlInput.className = 'homemedia-url full-width';
					homeMediaUrlInput.placeholder = 'Home Media Server URL (e.g., http://localhost:3003)';
					homeMediaUrlInput.style.marginTop = '0.5em';
					homeMediaUrlInput.value = extraConfig.homeMediaUrl || '';
					configDiv.insertBefore(homeMediaUrlInput, input);
					homeMediaUrlInput.addEventListener('input', updateLink);

					// Add help text with setup link
					const helpText = document.createElement('small');
					helpText.style.color = '#888';
					helpText.style.marginTop = '0.3em';
					helpText.style.display = 'block';
					helpText.innerHTML = 'URL to your personal media file server - <a href="https://github.com/sooti/stremio-addon-debrid-search/tree/main/media-file-server" target="_blank" style="color: #64ffda; text-decoration: underline;">Setup Guide</a>';
					configDiv.appendChild(helpText);
				}
			} else if (select.value === 'Usenet') {
				input.placeholder = 'Newznab API Key';

				// Add additional Usenet fields if they don't exist
				if (!configDiv.querySelector('.newznab-url')) {
					const newznabUrlInput = document.createElement('input');
					newznabUrlInput.type = 'text';
					newznabUrlInput.className = 'newznab-url full-width';
					newznabUrlInput.placeholder = 'Newznab URL (e.g., https://api.nzbgeek.info)';
					newznabUrlInput.style.marginTop = '0.5em';
					newznabUrlInput.value = extraConfig.newznabUrl || '';
					configDiv.insertBefore(newznabUrlInput, input);
					newznabUrlInput.addEventListener('input', updateLink);
				}

				if (!configDiv.querySelector('.sabnzbd-url')) {
					const sabnzbdUrlInput = document.createElement('input');
					sabnzbdUrlInput.type = 'text';
					sabnzbdUrlInput.className = 'sabnzbd-url full-width';
					sabnzbdUrlInput.placeholder = 'SABnzbd URL (e.g., localhost:8080 or http://ip:port)';
					sabnzbdUrlInput.style.marginTop = '0.5em';
					sabnzbdUrlInput.value = extraConfig.sabnzbdUrl || '';
					configDiv.appendChild(sabnzbdUrlInput);
					sabnzbdUrlInput.addEventListener('input', updateLink);

					const sabnzbdApiInput = document.createElement('input');
					sabnzbdApiInput.type = 'text';
					sabnzbdApiInput.className = 'sabnzbd-apikey full-width';
					sabnzbdApiInput.placeholder = 'SABnzbd API Key';
					sabnzbdApiInput.style.marginTop = '0.5em';
					sabnzbdApiInput.value = extraConfig.sabnzbdApiKey || '';
					configDiv.appendChild(sabnzbdApiInput);
					sabnzbdApiInput.addEventListener('input', updateLink);

					const fileServerInput = document.createElement('input');
					fileServerInput.type = 'text';
					fileServerInput.className = 'file-server-url full-width';
					fileServerInput.placeholder = 'File Server URL (Required - e.g., http://localhost:8081)';
					fileServerInput.style.marginTop = '0.5em';
					fileServerInput.value = extraConfig.fileServerUrl || '';
					configDiv.appendChild(fileServerInput);
					fileServerInput.addEventListener('input', updateLink);

					// Add file server password field
					const fileServerPasswordInput = document.createElement('input');
					fileServerPasswordInput.type = 'text';
					fileServerPasswordInput.className = 'file-server-password full-width';
					fileServerPasswordInput.placeholder = 'File Server Password (Optional - leave empty if not set)';
					fileServerPasswordInput.style.marginTop = '0.5em';
					fileServerPasswordInput.value = extraConfig.fileServerPassword || '';
					configDiv.appendChild(fileServerPasswordInput);
					fileServerPasswordInput.addEventListener('input', updateLink);

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
					deleteOnStopCheckbox.addEventListener('change', updateLink);
					autoCleanCheckbox.addEventListener('change', updateLink);
					cleanAgeInput.addEventListener('input', updateLink);
				}
			} else if (select.value === 'httpstreaming') {
				input.style.display = 'none';
				// Add HTTP Streaming configuration if it doesn't exist
				if (!configDiv.querySelector('.http-streaming-config')) {
					const httpConfigDiv = document.createElement('div');
					httpConfigDiv.className = 'http-streaming-config';
					httpConfigDiv.style.cssText = 'margin-top: 1em; padding: 0.8em; background: rgba(100, 255, 218, 0.05); border-radius: 5px; border: 1px solid rgba(100, 255, 218, 0.2);';
					httpConfigDiv.innerHTML = \`<div style=\"font-weight: 600; margin-bottom: 0.5em; color: #64ffda; font-size: 0.9rem;\">HTTP Streaming Sources</div><div style=\"display: flex; flex-direction: column; gap: 0.5em;\"><label style=\"display: flex; align-items: center; font-size: 0.9rem; cursor: pointer;\"><input type=\"checkbox\" class=\"http-4khdhub\" checked style=\"margin-right: 8px;">4KHDHub</label><label style=\"display: flex; align-items: center; font-size: 0.9rem; cursor: pointer;\"><input type=\"checkbox\" class=\"http-uhdmovies\" checked style=\"margin-right: 8px;">UHDMovies</label></div>\`;
					configDiv.appendChild(httpConfigDiv);
					// Add event listeners to update link when checkboxes change
					httpConfigDiv.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
						checkbox.addEventListener('change', updateLink);
					});
				}
			} else {
				input.placeholder = 'Enter API key';
				// Remove provider-specific fields
				const homeMediaUrl = configDiv.querySelector('.homemedia-url');
				const newznabUrl = configDiv.querySelector('.newznab-url');
				const sabnzbdUrl = configDiv.querySelector('.sabnzbd-url');
				const sabnzbdApiKey = configDiv.querySelector('.sabnzbd-apikey');
				const fileServerUrl = configDiv.querySelector('.file-server-url');
				const fileServerPassword = configDiv.querySelector('.file-server-password');
				const helpText = configDiv.querySelector('small');
				if (homeMediaUrl) homeMediaUrl.remove();
				if (newznabUrl) newznabUrl.remove();
				if (sabnzbdUrl) sabnzbdUrl.remove();
				if (sabnzbdApiKey) sabnzbdApiKey.remove();
				if (fileServerUrl) fileServerUrl.remove();
				if (fileServerPassword) fileServerPassword.remove();
				if (helpText) helpText.remove();
			}
		};

		updateUsenetFields();

		select.addEventListener('change', () => {
			updateUsenetFields();
			updateLink();
		});
		input.addEventListener('input', updateLink);
		removeBtn.addEventListener('click', () => {
			row.remove();
			updateLink();
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
		} else if (service.provider === 'HomeMedia') {
			extraConfig = {
				homeMediaUrl: service.homeMediaUrl || ''
			};
		}
		createServiceRow(service.provider, service.apiKey || '', extraConfig);
	});

	addServiceBtn.addEventListener('click', () => {
		createServiceRow();
		updateLink();
	});

	const languages = ${JSON.stringify(config.Languages) || '[]'};
	const languagesSelect = document.getElementById('Languages');
	for (const option of languagesSelect.options) {
		if (languages.includes(option.value)) {
			option.selected = true;
		}
	}

	// Initialize size sliders
	const minSizeSlider = document.getElementById('minSize');
	const maxSizeSlider = document.getElementById('maxSize');
	const minSizeLabel = document.getElementById('minSizeLabel');
	const maxSizeLabel = document.getElementById('maxSizeLabel');

	// Set initial values from config
	const initialMinSize = ${config.minSize || 0};
	const initialMaxSize = ${config.maxSize || 200};
	minSizeSlider.value = initialMinSize;
	maxSizeSlider.value = initialMaxSize;
	minSizeLabel.textContent = initialMinSize + ' GB';
	maxSizeLabel.textContent = initialMaxSize + ' GB';

	// Update labels when sliders change
	minSizeSlider.addEventListener('input', () => {
		let minVal = parseInt(minSizeSlider.value);
		let maxVal = parseInt(maxSizeSlider.value);
		if (minVal > maxVal) {
			minSizeSlider.value = maxVal;
			minVal = maxVal;
		}
		minSizeLabel.textContent = minVal + ' GB';
		updateLink();
	});

	maxSizeSlider.addEventListener('input', () => {
		let minVal = parseInt(minSizeSlider.value);
		let maxVal = parseInt(maxSizeSlider.value);
		if (maxVal < minVal) {
			maxSizeSlider.value = minVal;
			maxVal = minVal;
		}
		maxSizeLabel.textContent = maxVal + ' GB';
		updateLink();
	});

	installLink.onclick = (event) => {
		const services = getDebridServices();
		const allValid = services.every(s => {
			if (s.provider === 'Usenet') {
				return s.provider && s.apiKey && s.newznabUrl && s.sabnzbdUrl && s.sabnzbdApiKey && s.fileServerUrl;
			} else if (s.provider === 'HomeMedia') {
				return s.provider && s.homeMediaUrl; // API key is optional for Home Media
			} else if (s.provider === 'httpstreaming') {
				return true;
			}
			return s.provider && s.apiKey;
		});

		if (services.length === 0 || !allValid) {
			event.preventDefault();
			alert('Please complete all required fields for your services.');
		}
	}

	const copyLinkBtn = document.getElementById('copyLinkBtn');
	const toast = document.getElementById('toast');

	const showToast = () => {
		toast.classList.add('show');
		setTimeout(() => {
			toast.classList.remove('show');
		}, 2000);
	};

	copyLinkBtn.onclick = () => {
		const services = getDebridServices();
		const allValid = services.every(s => {
			if (s.provider === 'Usenet') {
				return s.provider && s.apiKey && s.newznabUrl && s.sabnzbdUrl && s.sabnzbdApiKey && s.fileServerUrl;
			} else if (s.provider === 'HomeMedia') {
				return s.provider && s.homeMediaUrl; // API key is optional for Home Media
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

		navigator.clipboard.writeText(manifestUrl).then(() => {
			showToast();
		}).catch(err => {
			// Fallback for older browsers
			const textArea = document.createElement('textarea');
			textArea.value = manifestUrl;
			textArea.style.position = 'fixed';
			textArea.style.left = '-999999px';
			document.body.appendChild(textArea);
			textArea.select();
			try {
				document.execCommand('copy');
				showToast();
			} catch (err) {
				alert('Failed to copy to clipboard');
			}
			document.body.removeChild(textArea);
		});
	};

	mainForm.oninput = updateLink;
	updateLink();
	`

    return `
	<!DOCTYPE html>
	<html style="background-image: url(${background});">

	<head>
		<meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${manifest.name} | Stremio Addon</title>
		<style>${STYLESHEET}</style>
		<link rel="shortcut icon" href="${logo}" type="image/x-icon">
		<link href="https://fonts.googleapis.com/css?family=Open+Sans:400,600,700&display=swap" rel="stylesheet">
	</head>

	<body>
		<div id="addon">
			<div class="logo">
			    <img src="${logo}">
			</div>
			<h1 class="name">${manifest.name}</h1>
			<h2 class="version">v${manifest.version || '0.0.0'} | ${manifest.description || ''}</h2>

            <hr class="separator">

			${formHTML}

            <hr class="separator">

            <h3>API Keys</h3>
            <p style="opacity: 0.8; margin-bottom: 1em;">Click the links below to get your API key from your debrid service provider:</p>
            <ul>
                <li><a href="https://real-debrid.com/apitoken" target="_blank">Real-Debrid API Key</a></li>
				<li><a href="https://torbox.app/settings" target="_blank">TorBox API Key</a></li>
                <li><a href="https://alldebrid.com/apikeys" target="_blank">AllDebrid API Key</a></li>
                <li><a href="https://www.premiumize.me/account" target="_blank">Premiumize API Key</a></li>
<!--                <li><a href="https://debrid-link.fr/webapp/apikey" target="_blank">Debrid.Link API Key</a></li> -->
    			<li><a href="https://offcloud.com/#/account" target="_blank">OffCloud API Key</a></li>
                <li><a href="https://debrider.app/dashboard/account" target="_blank">Debrider.app API Key</a></li>
            </ul>

            <p style="text-align: center; margin-top: 2em; opacity: 0.7;">Report any issues on <a href="https://github.com/sooti/stremio-addon-debrid-search" target="_blank">Github</a></p>

			<a id="installLink" class="install-link" href="#">
			    <button name="Install">INSTALL ADDON</button>
			</a>
			<button id="copyLinkBtn" class="copy-link-btn">COPY MANIFEST LINK</button>
			${contactHTML}
			<div id="toast" class="toast">Manifest link copied to clipboard!</div>
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
