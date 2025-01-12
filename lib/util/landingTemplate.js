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
	background-size: auto 100%;
	background-size: cover;
	background-position: center center;
	background-repeat: repeat-y;
}

body {
	font-size: 2.2vh;
}

body {
	display: flex;
    background-color: transparent;
	font-family: 'Open Sans', Arial, sans-serif;
	color: white;
}

h1 {
	font-size: 4.5vh;
	font-weight: 700;
}

h2 {
	font-size: 2.2vh;
	font-weight: normal;
	font-style: italic;
	opacity: 0.8;
}

h3 {
	font-size: 2.2vh;
    font-weight: normal;
}

h1,
h2,
h3,
p,
label {
	margin: 0;
	text-shadow: 0 0 1vh rgba(0, 0, 0, 0.15);
}

p {
	font-size: 1.75vh;
}

ul {
	font-size: 1.75vh;
	margin: 0;
	margin-top: 1vh;
	padding-left: 3vh;
}

li {
    margin-top: 0.3vh;
}

a {
	color: white;
}

a.install-link {
	text-decoration: none
}

button {
	border: 0;
	outline: 0;
	color: white;
	background: #8A5AAB;
	padding: 1.2vh 3.5vh;
	margin: auto;
	text-align: center;
	font-family: 'Open Sans', Arial, sans-serif;
	font-size: 2.2vh;
	font-weight: 600;
	cursor: pointer;
	display: block;
	box-shadow: 0 0.5vh 1vh rgba(0, 0, 0, 0.2);
	transition: box-shadow 0.1s ease-in-out;
}

button:hover {
	box-shadow: none;
}

button:active {
	box-shadow: 0 0 0 0.5vh white inset;
}

#addon {
   width: 90vh;
   margin: auto;
   padding-left: 10%;
   padding-right: 10%;
   background: rgba(0, 0, 0, 0.60);
}

.logo {
	height: 14vh;
	width: 14vh;
	margin: auto;
	margin-bottom: 3vh;
}

.logo img {
	width: 100%;
}

.name, .version {
	display: inline-block;
	vertical-align: top;
}

.name {
	line-height: 5vh;
	margin: 0;
}

.version {
	position: relative;
	line-height: 5vh;
	opacity: 0.8;
	margin-bottom: 2vh;
}

.contact {
	position: absolute;
	left: 0;
	bottom: 4vh;
	width: 100%;
	text-align: center;
}

.contact a {
	font-size: 1.4vh;
	font-style: italic;
}

.separator {
	margin-bottom: 3vh;
}

.label {
  font-size: 2.2vh;
  font-weight: 600;
  padding: 0;
  line-height: inherit;
}

.form-element {
	margin-bottom: 2vh;
}

.label-to-top {
	margin-bottom: 1vh;
}

.label-to-right {
	margin-left: 1vh !important;
}

.full-width {
	width: 100%;
}
`

function landingTemplate(manifest, config) {
    const background = manifest.background || 'https://dl.strem.io/addon-background.jpg'
    const logo = manifest.logo || 'https://dl.strem.io/addon-logo.png'
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
			<div class="label-to-top">Debrid Provider</div>
			<select id="DebridProvider" name="DebridProvider" class="full-width">
				<option value="RealDebrid">RealDebrid</option>
				<option value="DebridLink">DebridLink</option>
				<option value="AllDebrid">AllDebrid</option>
				<option value="Premiumize">Premiumize</option>
				<option value="TorBox">TorBox</option>
				<option value="OffCloud">OffCloud</option>
			</select>
		</div>
		<div class="form-element">
			<div class="label-to-top">Debrid API Key</div>
			<input type="text" id="DebridApiKey" name="DebridApiKey" class="full-width" required>
		</div>

		<div class="form-element">
			<label class="input" for="ShowCatalog">Show catalog</label>
			<input class="label" type="checkbox" id="ShowCatalog" name="ShowCatalog" value="true">
		</div>
	</form>

	<div class="separator"></div>
	`

	script += `
	console.log("${config.Catalog}")
	$('#DebridProvider option[value="${config.DebridProvider}"]').attr("selected", "selected");
	$('#DebridApiKey').val("${config.DebridApiKey || ''}");
	$('#ShowCatalog').prop('checked', ${config.ShowCatalog || false});

	installLink.onclick = () => {
		return mainForm.reportValidity()
	}

	const isValidConfig = (config) => {
		return config.DebridProvider && config.DebridApiKey
	}

	const updateLink = () => {
		const config = Object.fromEntries(new FormData(mainForm))
		if (isValidConfig(config)) {
			installLink.href = 'stremio://' + window.location.host + '/' + encodeURIComponent(JSON.stringify(config)) + '/manifest.json'
		} else {
			installLink.href = '#'
		}
	}
	mainForm.onchange = updateLink
	`

    return `
	<!DOCTYPE html>
	<html style="background-image: url(${background});">

	<head>
		<meta charset="utf-8">
		<title>${manifest.name} - Stremio Addon</title>
		<style>${STYLESHEET}</style>
		<link rel="shortcut icon" href="${logo}" type="image/x-icon">
		<link href="https://fonts.googleapis.com/css?family=Open+Sans:400,600,700&display=swap" rel="stylesheet">
      	<script src="https://code.jquery.com/jquery-3.7.1.slim.min.js"></script>
		<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/purecss@2.1.0/build/pure-min.css" integrity="sha384-yHIFVG6ClnONEA5yB5DJXfW2/KC173DIQrYoZMEtBvGzmf0PKiGyNEqe9N6BNDBH" crossorigin="anonymous">
	</head>

	<body>
		<div id="addon">
			<div class="logo">
			    <img src="${logo}">
			</div>
			<h1 class="name">${manifest.name}</h1>
			<h2 class="version">v${manifest.version || '0.0.0'}</h2>
			<h2 class="description">${manifest.description || ''}</h2>

            <div class="separator"></div>
            
            <p>Report any issues on <a href="https://github.com/MrMonkey42/stremio-addon-debrid-search/issues" target="_blank">Github</a></p>
            
            <div class="separator"></div>

            <h3 class="gives">Get the API Key here:</h3>
            <ul>
                <li><a href="https://real-debrid.com/apitoken" target="_blank">RealDebrid API Key</a></li>
                <li><a href="https://debrid-link.fr/webapp/apikey" target="_blank">DebridLink API Key</a></li>
                <li><a href="https://alldebrid.com/apikeys" target="_blank">AllDebrid API Key</a></li>
                <li><a href="https://www.premiumize.me/account" target="_blank">Premiumize API Key</a></li>
				<li><a href="https://torbox.app/settings" target="_blank">TorBox API Key</a></li>
    			<li><a href="https://offcloud.com/#/account" target="_blank">OffCloud API Key</a></li>
            </ul>

			<div class="separator"></div>

			${formHTML}

			<a id="installLink" class="install-link" href="#">
			    <button name="Install">INSTALL</button>
			</a>
			${contactHTML}
		</div>
		<script>
			${script}

			if (typeof updateLink === 'function')
			    updateLink()
			else
			    installLink.href = 'stremio://' + window.location.host + '/manifest.json'
		</script>
	</body>

	</html>`
}

export default landingTemplate
