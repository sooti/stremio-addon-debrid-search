function renderAdvancedConfigPage(manifest, config, logo) {
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${manifest.name} - Advanced Configuration</title>
    <link rel="icon" type="image/svg+xml" href="${logo}">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css" rel="stylesheet"/>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
    <style>
        * { -webkit-tap-highlight-color: transparent; }
        body { font-family: 'Inter', sans-serif; overflow-x: hidden; }
        
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        ::-webkit-scrollbar-track {
            background: #0a0a0a;
        }
        ::-webkit-scrollbar-thumb {
            background: #374151;
            border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: #4b5563;
        }
        * {
            scrollbar-width: thin;
            scrollbar-color: #374151 #0a0a0a;
        }
        .custom-bg { background: #0f1729; }
        .custom-bg-card { background: #1a2332; }
        .custom-border { border-color: #2a3547; }
        .custom-cyan { color: #4ac4b1; }
        
        .custom-btn {
            background-color: #4ac4b1;
            color: #0a0f1c;
            font-weight: 600;
            min-height: 48px;
        }
        .custom-btn:active {
            background-color: #4fd4c1;
            transform: scale(0.98);
        }
        .custom-btn-outline {
            border: 2px solid #4ac4b1;
            color: #4ac4b1;
            background: transparent;
            min-height: 48px;
        }
        .custom-btn-outline:active {
            background-color: rgba(100, 255, 218, 0.15);
        }
        .custom-btn-remove {
            border: 1px solid #ff4444;
            color: #ff4444;
            background: transparent;
            min-height: 44px;
        }
        .custom-btn-remove:active {
            background-color: rgba(255, 68, 68, 0.15);
        }
        select, input[type="text"], input[type="range"] {
            background-color: #0f1729;
            border-color: #2a3547;
            color: #fff;
        }
        input[type="text"], select {
            min-height: 48px;
        }
        input[type="text"]:focus, select:focus {
            border-color: #4ac4b1;
            outline: none;
            box-shadow: 0 0 0 3px rgba(100, 255, 218, 0.1);
        }
        .range-slider {
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 8px;
            background: #2a3547;
            outline: none;
            border-radius: 4px;
        }
        .range-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 24px;
            height: 24px;
            background: #4ac4b1;
            cursor: pointer;
            border-radius: 50%;
        }
        .range-slider::-moz-range-thumb {
            width: 24px;
            height: 24px;
            background: #4ac4b1;
            cursor: pointer;
            border-radius: 50%;
            border: none;
        }
        .desktop-sidebar { display: none; }
        .bottom-nav {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: #0a0f1c;
            border-top: 1px solid #2a3547;
            z-index: 100;
            padding-bottom: env(safe-area-inset-bottom);
        }
        .mobile-menu {
            position: fixed;
            inset: 0;
            background: #0a0f1c;
            z-index: 200;
            transform: translateX(-100%);
            transition: transform 0.3s ease;
        }
        .mobile-menu.active { transform: translateX(0); }
        .card-section { animation: slideUp 0.3s ease; }
        @keyframes slideUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .touch-item:active { background-color: rgba(100, 255, 218, 0.05); }
        .section-content { display: none; }
        .section-content.active { display: block; }
        
        @media (min-width: 1024px) {
            .bottom-nav { display: none; }
            .desktop-sidebar { display: block; }
            .mobile-only { display: none; }
            .desktop-header { display: flex !important; }
            .mobile-header { display: none !important; }
        }
        
        select {
            padding-right: 2.5rem !important;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%2364ffda' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3E%3C/svg%3E");
            background-position: right 0.75rem center;
            background-repeat: no-repeat;
            background-size: 1.25em 1.25em;
            appearance: none;
            -webkit-appearance: none;
            -moz-appearance: none;
            color: #fff !important;
        }
        select option {
            background-color: #0f1729;
            color: #fff;
            padding: 8px;
        }
        
        .checkbox-custom {
            appearance: none;
            width: 1.25rem;
            height: 1.25rem;
            border: 2px solid #4b5563;
            border-radius: 0.25rem;
            background: #111827;
            cursor: pointer;
            transition: all 0.2s;
            position: relative;
        }
        .checkbox-custom:checked {
            background: #4ac4b1;
            border-color: #4ac4b1;
        }
        .checkbox-custom:checked::after {
            content: '';
            position: absolute;
            left: 4px;
            top: 1px;
            width: 5px;
            height: 10px;
            border: solid #0a0a0a;
            border-width: 0 2px 2px 0;
            transform: rotate(45deg);
        }
    </style>
</head>
<body class="custom-bg">
    <!-- Mobile Header -->
    <div class="mobile-header sticky top-0 z-50 bg-[#0a0f1c] border-b border-[#2a3547] px-4 py-3" style="display: flex;">
        <div class="flex items-center justify-between w-full">
            <button onclick="toggleMobileMenu()" class="text-white p-2 -ml-2">
                <i class="fas fa-bars text-xl"></i>
            </button>
            <div class="flex items-center space-x-2">
                <img src="${logo}" alt="Sootio" class="w-8 h-8">
                <span class="text-white text-lg font-semibold">Sootio</span>
            </div>
            <button onclick="location.reload()" class="text-[#4ac4b1] p-2 -mr-2">
                <i class="fas fa-sync-alt text-xl"></i>
            </button>
        </div>
    </div>

    <!-- Desktop Header -->
    <div class="desktop-header items-center px-6 py-4 justify-between border-b border-[#2a3547] bg-[#0a0f1c]" style="display: none;">
        <div class="flex items-center space-x-4">
            <img src="${logo}" alt="Sootio" class="w-8 h-8">
            <span class="text-white text-xl font-semibold">Sootio</span>
        </div>
        <div class="flex items-center space-x-6">
            <button onclick="location.reload()" class="custom-cyan text-lg cursor-pointer hover:opacity-80">
                <i class="fas fa-sync-alt"></i>
            </button>
        </div>
    </div>

    <div class="flex">
        <!-- Desktop Sidebar -->
        <aside class="desktop-sidebar bg-[#0a0f1c] w-64 min-h-screen pt-4 pb-8 border-r border-[#2a3547]">
            <ul class="space-y-1 mt-2">
                <li>
                    <a onclick="showSection('dashboard')" class="nav-link flex items-center px-6 py-3 text-white bg-[#1a2332] border-l-4 border-[#4ac4b1] cursor-pointer" data-section="dashboard">
                        <i class="fas fa-home mr-3 w-5"></i>
                        Dashboard
                    </a>
                </li>
                <li>
                    <a onclick="showSection('debrid')" class="nav-link flex items-center px-6 py-3 text-[#8b92a7] hover:bg-[#1a2332] hover:text-white transition cursor-pointer" data-section="debrid">
                        <i class="fas fa-server mr-3 w-5"></i>
                        Debrid Services
                    </a>
                </li>
                <li>
                    <a onclick="showSection('language')" class="nav-link flex items-center px-6 py-3 text-[#8b92a7] hover:bg-[#1a2332] hover:text-white transition cursor-pointer" data-section="language">
                        <i class="fas fa-language mr-3 w-5"></i>
                        Language Filter
                    </a>
                </li>
                <li>
                    <a onclick="showSection('filesize')" class="nav-link flex items-center px-6 py-3 text-[#8b92a7] hover:bg-[#1a2332] hover:text-white transition cursor-pointer" data-section="filesize">
                        <i class="fas fa-hdd mr-3 w-5"></i>
                        File Size Filter
                    </a>
                </li>
                <li>
                    <a onclick="switchToStandardMode()" class="flex items-center px-6 py-3 text-[#8b92a7] hover:bg-[#1a2332] hover:text-white transition cursor-pointer">
                        <i class="fas fa-arrow-left mr-3 w-5"></i>
                        Standard Mode
                    </a>
                </li>
            </ul>
        </aside>

        <!-- Main Content -->
        <main class="flex-1 custom-bg pb-24 lg:pb-8">
            <div class="p-4 lg:p-8 max-w-5xl mx-auto">
                
                <!-- Dashboard Section -->
                <div id="dashboard-section" class="section-content active">
                    <div class="mb-6">
                        <h1 class="text-white text-2xl lg:text-3xl font-semibold mb-2">Dashboard</h1>
                        <p class="text-[#8b92a7] text-sm">v${manifest.version || '0.0.0'} | Overview of your Sootio configuration</p>
                    </div>

                    
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                        <div class="custom-bg-card rounded-xl border border-[#2a3547] p-6">
                            <div class="flex items-center justify-between mb-2">
                                <span class="text-[#8b92a7] text-sm">Services Configured</span>
                                <i class="fas fa-server text-[#4ac4b1]"></i>
                            </div>
                            <div class="text-white text-2xl font-bold" id="service-count">${config.DebridServices ? config.DebridServices.length : 0}</div>
                        </div>
                        <div class="custom-bg-card rounded-xl border border-[#2a3547] p-6">
                            <div class="flex items-center justify-between mb-2">
                                <span class="text-[#8b92a7] text-sm">Configuration Status</span>
                                <i class="fas fa-check-circle text-[#4ac4b1]"></i>
                            </div>
                            <div class="text-white text-2xl font-bold">Active</div>
                        </div>
                    </div>

                    
                    <div class="custom-bg-card rounded-xl border border-[#2a3547] p-6 mb-6">
                        <h2 class="text-white text-lg font-semibold mb-4">Quick Actions</h2>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <button onclick="reinstallAddon(event)" class="custom-btn w-full px-6 py-3 rounded-lg text-sm font-semibold transition">
                                <i class="fas fa-download mr-2"></i>Reinstall Addon
                            </button>
                            <button onclick="showSection('debrid')" class="custom-btn-outline w-full px-6 py-3 rounded-lg text-sm font-medium transition">
                                <i class="fas fa-cog mr-2"></i>Configure Services
                            </button>
                        </div>
                    </div>
                </div>

                
                <div id="debrid-section" class="section-content">
                    <div class="mb-6">
                        <h1 class="text-white text-2xl lg:text-3xl font-semibold mb-2">Debrid Services</h1>
                        <p class="text-[#8b92a7] text-sm">Manage your debrid and usenet services</p>
                    </div>

                    <div class="card-section custom-bg-card rounded-xl border border-[#2a3547] p-4 mb-4">
                        <p class="text-[#8b92a7] text-sm mb-4">Services are queried simultaneously for best results</p>
                        
                        <div id="services-container" class="space-y-3 mb-4"></div>

                        <button class="custom-btn-outline w-full px-4 py-3 rounded-lg text-sm font-medium transition" onclick="addService()">
                            <i class="fas fa-plus mr-2"></i>Add Another Service
                        </button>
                    </div>

                    <button onclick="saveConfiguration()" class="custom-btn w-full px-6 py-4 rounded-xl text-base font-semibold transition">
                        <i class="fas fa-save mr-2"></i>Save Configuration
                    </button>
                    
                    <button onclick="copyManifestLinkAdvanced(event)" class="w-full px-6 py-3 mt-3 rounded-xl text-sm text-gray-400 hover:text-[#4ac4b1] transition">
                         Copy Manifest Link
                    </button>
                </div>

                
                <div id="language-section" class="section-content">
                    <div class="mb-6">
                        <h1 class="text-white text-2xl lg:text-3xl font-semibold mb-2">Language Filter</h1>
                        <p class="text-[#8b92a7] text-sm">Filter content by audio language</p>
                    </div>

                    <div class="card-section custom-bg-card rounded-xl border border-[#2a3547] p-4 mb-4">
                        <p class="text-[#8b92a7] text-sm mb-4">Select one or more languages. If none selected, no language filter is applied.</p>
                        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3" id="languages-container"></div>
                    </div>

                    <button onclick="saveConfiguration()" class="custom-btn w-full px-6 py-4 rounded-xl text-base font-semibold transition">
                        <i class="fas fa-save mr-2"></i>Save Configuration
                    </button>
                    
                    <button onclick="copyManifestLinkAdvanced(event)" class="w-full px-6 py-3 mt-3 rounded-xl text-sm text-gray-400 hover:text-[#4ac4b1] transition">
                         Copy Manifest Link
                    </button>
                </div>

                
                <div id="filesize-section" class="section-content">
                    <div class="mb-6">
                        <h1 class="text-white text-2xl lg:text-3xl font-semibold mb-2">File Size Filter</h1>
                        <p class="text-[#8b92a7] text-sm">Set minimum and maximum file sizes</p>
                    </div>

                    <div class="card-section custom-bg-card rounded-xl border border-[#2a3547] p-4 mb-4">
                        <p class="text-[#8b92a7] text-sm mb-6">Set to 0-200 for no filtering</p>
                        
                        <div class="space-y-6">
                            <div>
                                <div class="flex justify-between mb-3">
                                    <label class="text-[#8b92a7] text-sm">Minimum Size</label>
                                    <span class="text-white text-sm font-semibold"><span id="min-value">0</span> GB</span>
                                </div>
                                <input type="range" id="minSize" min="0" max="200" value="${config.minSize || 0}" class="range-slider w-full" oninput="document.getElementById('min-value').textContent = this.value">
                            </div>
                            <div>
                                <div class="flex justify-between mb-3">
                                    <label class="text-[#8b92a7] text-sm">Maximum Size</label>
                                    <span class="text-white text-sm font-semibold"><span id="max-value">200</span> GB</span>
                                </div>
                                <input type="range" id="maxSize" min="0" max="200" value="${config.maxSize || 200}" class="range-slider w-full" oninput="document.getElementById('max-value').textContent = this.value">
                            </div>
                        </div>
                    </div>

                    <button onclick="saveConfiguration()" class="custom-btn w-full px-6 py-4 rounded-xl text-base font-semibold transition">
                        <i class="fas fa-save mr-2"></i>Save Configuration
                    </button>
                    
                    <button onclick="copyManifestLinkAdvanced(event)" class="w-full px-6 py-3 mt-3 rounded-xl text-sm text-gray-400 hover:text-[#4ac4b1] transition">
                         Copy Manifest Link
                    </button>
                </div>

                
                <div class="text-center text-xs text-[#8b92a7] py-4 mt-6">
                    Report issues on <a href="https://github.com/sooti/stremio-addon-debrid-search" target="_blank" class="custom-cyan hover:underline">Github</a>
                </div>
            </div>
        </main>
    </div>

    
    <nav class="bottom-nav">
        <div class="flex justify-around items-center py-2 px-2">
            <a onclick="showSection('dashboard')" class="mobile-nav-link flex flex-col items-center py-2 px-3 text-[#4ac4b1] cursor-pointer" data-section="dashboard">
                <i class="fas fa-home text-xl mb-1"></i>
                <span class="text-xs font-medium">Dashboard</span>
            </a>
            <a onclick="showSection('debrid')" class="mobile-nav-link flex flex-col items-center py-2 px-3 text-[#8b92a7] cursor-pointer" data-section="debrid">
                <i class="fas fa-server text-xl mb-1"></i>
                <span class="text-xs font-medium">Services</span>
            </a>
            <a onclick="showSection('language')" class="mobile-nav-link flex flex-col items-center py-2 px-3 text-[#8b92a7] cursor-pointer" data-section="language">
                <i class="fas fa-language text-xl mb-1"></i>
                <span class="text-xs font-medium">Language</span>
            </a>
            <a onclick="showSection('filesize')" class="mobile-nav-link flex flex-col items-center py-2 px-3 text-[#8b92a7] cursor-pointer" data-section="filesize">
                <i class="fas fa-hdd text-xl mb-1"></i>
                <span class="text-xs font-medium">Size</span>
            </a>
        </div>
    </nav>

    
    <div class="mobile-menu">
        <div class="flex items-center justify-between p-4 border-b border-[#2a3547]">
            <div class="flex items-center space-x-3">
                <img src="${logo}" alt="Sootio" class="w-8 h-8">
                <span class="text-white text-lg font-semibold">Menu</span>
            </div>
            <button onclick="toggleMobileMenu()" class="text-white p-2">
                <i class="fas fa-times text-xl"></i>
            </button>
        </div>
        <ul class="p-4 space-y-1">
            <li><a onclick="showSection('dashboard'); toggleMobileMenu();" data-section="dashboard" class="hamburger-menu-link flex items-center px-4 py-4 text-white bg-[#1a2332] rounded-lg border-l-4 border-[#4ac4b1] cursor-pointer"><i class="fas fa-home mr-3 w-5"></i>Dashboard</a></li>
            <li><a onclick="showSection('debrid'); toggleMobileMenu();" data-section="debrid" class="hamburger-menu-link flex items-center px-4 py-4 text-[#8b92a7] rounded-lg touch-item cursor-pointer"><i class="fas fa-server mr-3 w-5"></i>Debrid Services</a></li>
            <li><a onclick="showSection('language'); toggleMobileMenu();" data-section="language" class="hamburger-menu-link flex items-center px-4 py-4 text-[#8b92a7] rounded-lg touch-item cursor-pointer"><i class="fas fa-language mr-3 w-5"></i>Language Filter</a></li>
            <li><a onclick="showSection('filesize'); toggleMobileMenu();" data-section="filesize" class="hamburger-menu-link flex items-center px-4 py-4 text-[#8b92a7] rounded-lg touch-item cursor-pointer"><i class="fas fa-hdd mr-3 w-5"></i>File Size Filter</a></li>
            <li><a onclick="switchToStandardMode()" class="flex items-center px-4 py-4 text-[#8b92a7] rounded-lg touch-item cursor-pointer"><i class="fas fa-arrow-left mr-3 w-5"></i>Standard Mode</a></li>
        </ul>
    </div>

    <div id="modeSwitchModal" onclick="if(event.target === this) closeModeSwitchModal()" class="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-[250] hidden">
        <div class="bg-[#1a2332] rounded-lg p-8 max-w-md mx-4 border-2 border-[#4ac4b1] shadow-2xl">
            <div class="text-center mb-6">
                <div class="inline-block p-3 bg-[#4ac4b1] bg-opacity-20 rounded-full mb-4">
                    <svg class="w-12 h-12 text-[#4ac4b1]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                    </svg>
                </div>
                <h3 class="text-white text-xl font-semibold mb-2">Configuration Style Updated</h3>
                <p class="text-gray-400 text-sm mb-6">You've switched to <span id="newModeName" class="text-[#4ac4b1] font-semibold"></span> mode. To save this preference, you need to reinstall the addon.</p>
            </div>
            <div class="flex gap-3">
                <button onclick="closeModeSwitchModal()" class="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors font-medium">
                    Later
                </button>
                <button onclick="reinstallFromModal()" class="flex-1 px-4 py-3 bg-[#4ac4b1] hover:bg-[#4fd4c1] text-[#0a0a0a] rounded-lg transition-colors font-semibold">
                    Reinstall Now
                </button>
            </div>
        </div>
    </div>

    <script>
        let serviceIndex = 0;
        const existingServices = ${JSON.stringify(config.DebridServices || [])};
        const existingLanguages = ${JSON.stringify(config.Languages || [])};
        
        const languages = [
            { code: 'en', label: 'English' },
            { code: 'fr', label: 'French' },
            { code: 'es', label: 'Spanish' },
            { code: 'de', label: 'German' },
            { code: 'it', label: 'Italian' },
            { code: 'pt', label: 'Portuguese' },
            { code: 'ru', label: 'Russian' },
            { code: 'hi', label: 'Hindi' },
            { code: 'ja', label: 'Japanese' },
            { code: 'ko', label: 'Korean' },
            { code: 'zh', label: 'Chinese' },
            { code: 'ar', label: 'Arabic' },
            { code: 'tr', label: 'Turkish' },
            { code: 'nl', label: 'Dutch' },
            { code: 'sv', label: 'Swedish' },
            { code: 'no', label: 'Norwegian' },
            { code: 'da', label: 'Danish' },
            { code: 'fi', label: 'Finnish' },
            { code: 'pl', label: 'Polish' },
            { code: 'cs', label: 'Czech' },
            { code: 'hu', label: 'Hungarian' },
            { code: 'ro', label: 'Romanian' },
            { code: 'el', label: 'Greek' },
            { code: 'he', label: 'Hebrew' },
            { code: 'th', label: 'Thai' },
            { code: 'ta', label: 'Tamil' },
            { code: 'ml', label: 'Malayalam' },
            { code: 'te', label: 'Telugu' },
            { code: 'kn', label: 'Kannada' },
            { code: 'es-419', label: 'Latino' }
        ];
        
        const flagMap = {
            'en': '🇬🇧', 'fr': '🇫🇷', 'es': '🇪🇸', 'de': '🇩🇪', 'it': '🇮🇹', 'pt': '🇵🇹',
            'ru': '🇷🇺', 'hi': '🇮🇳', 'ja': '🇯🇵', 'ko': '🇰🇷', 'zh': '🇨🇳', 'ar': '🇦🇪',
            'tr': '🇹🇷', 'nl': '🇳🇱', 'sv': '🇸🇪', 'no': '🇳🇴', 'da': '🇩🇰', 'fi': '🇫🇮',
            'pl': '🇵🇱', 'cs': '🇨🇿', 'hu': '🇭🇺', 'ro': '🇷🇴', 'el': '🇬🇷', 'he': '🇮🇱',
            'th': '🇹🇭', 'ta': '🇮🇳', 'ml': '🇮🇳', 'te': '🇮🇳', 'kn': '🇮🇳', 'es-419': '🇲🇽'
        };
        
        function toggleMobileMenu() {
            document.querySelector('.mobile-menu').classList.toggle('active');
        }
        
        function showSection(sectionName) {
            // Hide all sections
            document.querySelectorAll('.section-content').forEach(el => el.classList.remove('active'));
            // Show selected section
            document.getElementById(sectionName + '-section').classList.add('active');
            
            // Update desktop nav
            document.querySelectorAll('.nav-link').forEach(link => {
                link.classList.remove('bg-[#1a2332]', 'border-l-4', 'border-[#4ac4b1]', 'text-white');
                link.classList.add('text-[#8b92a7]');
            });
            const activeLink = document.querySelector(\`.nav-link[data-section="\${sectionName}"]\`);
            if (activeLink) {
                activeLink.classList.add('bg-[#1a2332]', 'border-l-4', 'border-[#4ac4b1]', 'text-white');
                activeLink.classList.remove('text-[#8b92a7]');
            }
            
            // Update mobile nav
            document.querySelectorAll('.mobile-nav-link').forEach(link => {
                link.classList.remove('text-[#4ac4b1]');
                link.classList.add('text-[#8b92a7]');
            });
            const activeMobileLink = document.querySelector(\`.mobile-nav-link[data-section="\${sectionName}"]\`);
            if (activeMobileLink) {
                activeMobileLink.classList.add('text-[#4ac4b1]');
                activeMobileLink.classList.remove('text-[#8b92a7]');
            }
            
            // Update hamburger menu
            document.querySelectorAll('.hamburger-menu-link').forEach(link => {
                link.classList.remove('bg-[#1a2332]', 'border-l-4', 'border-[#4ac4b1]', 'text-white');
                link.classList.add('text-[#8b92a7]');
            });
            const activeHamburgerLink = document.querySelector(\`.hamburger-menu-link[data-section="\${sectionName}"]\`);
            if (activeHamburgerLink) {
                activeHamburgerLink.classList.add('bg-[#1a2332]', 'border-l-4', 'border-[#4ac4b1]', 'text-white');
                activeHamburgerLink.classList.remove('text-[#8b92a7]');
            }
        }
        
        function addService(provider = 'RealDebrid', apiKey = '', extraConfig = {}) {
            const container = document.getElementById('services-container');
            const index = serviceIndex++;
            
            const serviceDiv = document.createElement('div');
            serviceDiv.className = 'bg-[#0f1729] rounded-lg p-3 border border-[#2a3547]';
            serviceDiv.dataset.index = index;
            
            serviceDiv.innerHTML = \`
                <div class="flex flex-col sm:flex-row gap-2 mb-2">
                    <select class="debrid-provider flex-1 px-3 py-3 rounded-lg border border-[#2a3547] text-sm">
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
                    <div class="flex-1 flex gap-2">
                        <input type="text" placeholder="Enter API key" class="debrid-apikey flex-1 px-3 py-3 rounded-lg border border-[#2a3547] text-sm">
                        <a href="#" class="get-key-link text-[#4ac4b1] hover:text-[#4fd4c1] text-xs self-center whitespace-nowrap px-2" target="_blank">Get key</a>
                    </div>
                </div>
                <div class="service-config mb-2"></div>
                <button class="custom-btn-remove w-full px-4 py-2.5 rounded-lg text-sm font-medium transition" onclick="removeService(\${index})">
                    <i class="fas fa-trash mr-2"></i>Remove Service
                </button>
            \`;
            
            container.appendChild(serviceDiv);
            
            const select = serviceDiv.querySelector('.debrid-provider');
            const input = serviceDiv.querySelector('.debrid-apikey');
            const getKeyLink = serviceDiv.querySelector('.get-key-link');
            
            select.value = provider;
            input.value = apiKey;
            
            function updateGetKeyLink() {
                const keyUrls = {
                    'RealDebrid': 'https://real-debrid.com/apitoken',
                    'TorBox': 'https://torbox.app/settings',
                    'AllDebrid': 'https://alldebrid.com/apikeys',
                    'Premiumize': 'https://www.premiumize.me/account',
                    'OffCloud': 'https://offcloud.com/#/account',
                    'DebriderApp': 'https://debrider.app/dashboard/account'
                };
                getKeyLink.href = keyUrls[select.value] || '#';
                getKeyLink.style.display = keyUrls[select.value] ? 'inline' : 'none';
            }
            
            updateGetKeyLink();
            
            function updateProviderFields() {
                const configDiv = serviceDiv.querySelector('.service-config');
                configDiv.innerHTML = '';
                updateGetKeyLink();
                
                if (select.value === 'Usenet') {
                    input.placeholder = 'Newznab API Key';
                    input.style.display = '';
                    configDiv.innerHTML = \`
                        <input type="text" placeholder="Newznab URL" class="newznab-url w-full px-3 py-3 rounded-lg border border-[#2a3547] text-sm mb-2" value="\${extraConfig.newznabUrl || ''}">
                        <input type="text" placeholder="SABnzbd URL" class="sabnzbd-url w-full px-3 py-3 rounded-lg border border-[#2a3547] text-sm mb-2" value="\${extraConfig.sabnzbdUrl || ''}">
                        <input type="text" placeholder="SABnzbd API Key" class="sabnzbd-apikey w-full px-3 py-3 rounded-lg border border-[#2a3547] text-sm mb-2" value="\${extraConfig.sabnzbdApiKey || ''}">
                        <input type="text" placeholder="File Server URL" class="file-server-url w-full px-3 py-3 rounded-lg border border-[#2a3547] text-sm mb-2" value="\${extraConfig.fileServerUrl || ''}">
                        <input type="text" placeholder="File Server Password (Optional)" class="file-server-password w-full px-3 py-3 rounded-lg border border-[#2a3547] text-sm mb-2" value="\${extraConfig.fileServerPassword || ''}">
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-3 mt-2 mb-2">
                            <div class="text-[#4ac4b1] font-semibold text-xs mb-2">Cleanup Options</div>
                            <label class="flex items-center space-x-2 mb-1.5 cursor-pointer">
                                <input type="checkbox" class="usenet-delete-on-stop" \${extraConfig.deleteOnStreamStop ? 'checked' : ''}>
                                <span class="text-white text-xs">Delete file when stream stops</span>
                            </label>
                            <label class="flex items-center space-x-2 mb-1.5 cursor-pointer">
                                <input type="checkbox" class="usenet-auto-clean" \${extraConfig.autoCleanOldFiles ? 'checked' : ''}>
                                <span class="text-white text-xs">Auto-clean old files</span>
                            </label>
                            <div class="flex items-center space-x-2 ml-4">
                                <label class="text-gray-400 text-xs">Days:</label>
                                <input type="number" class="usenet-clean-age bg-[#1a2332] border border-[#2a3547] rounded px-2 py-1 text-white text-xs w-16" min="1" max="365" value="\${extraConfig.autoCleanAgeDays || 7}">
                            </div>
                        </div>
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-3 mt-2">
                            <div class="text-[#4ac4b1] font-semibold text-xs mb-2">HTTP Streaming Sources</div>
                            <label class="flex items-center space-x-2 mb-1.5 cursor-pointer">
                                <input type="checkbox" class="usenet-http-4khdhub" \${extraConfig.http4khdhub !== false ? 'checked' : ''}>
                                <span class="text-white text-xs">4KHDHub</span>
                            </label>
                            <label class="flex items-center space-x-2 cursor-pointer">
                                <input type="checkbox" class="usenet-http-uhdmovies" \${extraConfig.httpUHDMovies !== false ? 'checked' : ''}>
                                <span class="text-white text-xs">UHDMovies</span>
                            </label>
                        </div>
                    \`;
                } else if (select.value === 'HomeMedia') {
                    input.placeholder = 'Home Media API Key (Optional)';
                    input.style.display = '';
                    configDiv.innerHTML = \`
                        <input type="text" placeholder="Home Media Server URL (e.g., http://localhost:3003)" class="homemedia-url w-full px-3 py-3 rounded-lg border border-[#2a3547] text-sm mb-2" value="\${extraConfig.homeMediaUrl || ''}">
                        <p class="text-gray-400 text-xs mb-2">URL to your personal media file server - <a href="https://github.com/sooti/stremio-addon-debrid-search/tree/main/media-file-server" target="_blank" class="text-[#4ac4b1] hover:underline">Setup Guide</a></p>
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-3 mt-2 mb-2">
                            <div class="text-[#4ac4b1] font-semibold text-xs mb-2">Cleanup Options</div>
                            <label class="flex items-center space-x-2 mb-1.5 cursor-pointer">
                                <input type="checkbox" class="homemedia-delete-on-stop" \${extraConfig.deleteOnStreamStop ? 'checked' : ''}>
                                <span class="text-white text-xs">Delete file when stream stops</span>
                            </label>
                            <label class="flex items-center space-x-2 mb-1.5 cursor-pointer">
                                <input type="checkbox" class="homemedia-auto-clean" \${extraConfig.autoCleanOldFiles ? 'checked' : ''}>
                                <span class="text-white text-xs">Auto-clean old files</span>
                            </label>
                            <div class="flex items-center space-x-2 ml-4">
                                <label class="text-gray-400 text-xs">Days:</label>
                                <input type="number" class="homemedia-clean-age bg-[#1a2332] border border-[#2a3547] rounded px-2 py-1 text-white text-xs w-16" min="1" max="365" value="\${extraConfig.autoCleanAgeDays || 7}">
                            </div>
                        </div>
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-3 mt-2">
                            <div class="text-[#4ac4b1] font-semibold text-xs mb-2">HTTP Streaming Sources</div>
                            <label class="flex items-center space-x-2 mb-1.5 cursor-pointer">
                                <input type="checkbox" class="homemedia-http-4khdhub" \${extraConfig.http4khdhub !== false ? 'checked' : ''}>
                                <span class="text-white text-xs">4KHDHub</span>
                            </label>
                            <label class="flex items-center space-x-2 cursor-pointer">
                                <input type="checkbox" class="homemedia-http-uhdmovies" \${extraConfig.httpUHDMovies !== false ? 'checked' : ''}>
                                <span class="text-white text-xs">UHDMovies</span>
                            </label>
                        </div>
                    \`;
                } else if (select.value === 'httpstreaming') {
                    input.style.display = 'none';
                    configDiv.innerHTML = \`
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-4 mt-2">
                            <div class="text-[#4ac4b1] font-semibold text-sm mb-3">HTTP Streaming Sources</div>
                            <label class="flex items-center space-x-2 mb-2 cursor-pointer">
                                <input type="checkbox" class="http-4khdhub" \${extraConfig.http4khdhub !== false ? 'checked' : ''}>
                                <span class="text-white text-sm">4KHDHub</span>
                            </label>
                            <label class="flex items-center space-x-2 cursor-pointer">
                                <input type="checkbox" class="http-uhdmovies" \${extraConfig.httpUHDMovies !== false ? 'checked' : ''}>
                                <span class="text-white text-sm">UHDMovies</span>
                            </label>
                        </div>
                    \`;
                } else {
                    input.style.display = '';
                    input.placeholder = 'Enter API key';
                }
            }
            
            select.addEventListener('change', updateProviderFields);
            updateProviderFields();
            updateServiceCount();
        }
        
        function removeService(index) {
            const serviceDiv = document.querySelector(\`[data-index="\${index}"]\`);
            if (serviceDiv) {
                serviceDiv.remove();
                updateServiceCount();
            }
        }
        
        function updateServiceCount() {
            const count = document.querySelectorAll('#services-container [data-index]').length;
            document.getElementById('service-count').textContent = count;
        }
        
        function getDebridServices() {
            const services = [];
            const rows = document.querySelectorAll('#services-container [data-index]');
            rows.forEach(row => {
                const provider = row.querySelector('.debrid-provider').value;
                const apiKey = row.querySelector('.debrid-apikey').value;
                
                if (provider === 'Usenet') {
                    services.push({
                        provider,
                        apiKey,
                        newznabUrl: row.querySelector('.newznab-url')?.value || '',
                        sabnzbdUrl: row.querySelector('.sabnzbd-url')?.value || '',
                        sabnzbdApiKey: row.querySelector('.sabnzbd-apikey')?.value || '',
                        fileServerUrl: row.querySelector('.file-server-url')?.value || '',
                        fileServerPassword: row.querySelector('.file-server-password')?.value || '',
                        deleteOnStreamStop: row.querySelector('.usenet-delete-on-stop')?.checked || false,
                        autoCleanOldFiles: row.querySelector('.usenet-auto-clean')?.checked || false,
                        autoCleanAgeDays: parseInt(row.querySelector('.usenet-clean-age')?.value) || 7,
                        http4khdhub: row.querySelector('.usenet-http-4khdhub')?.checked ?? true,
                        httpUHDMovies: row.querySelector('.usenet-http-uhdmovies')?.checked ?? true
                    });
                } else if (provider === 'HomeMedia') {
                    services.push({
                        provider,
                        apiKey: apiKey || '',
                        homeMediaUrl: row.querySelector('.homemedia-url')?.value || '',
                        deleteOnStreamStop: row.querySelector('.homemedia-delete-on-stop')?.checked || false,
                        autoCleanOldFiles: row.querySelector('.homemedia-auto-clean')?.checked || false,
                        autoCleanAgeDays: parseInt(row.querySelector('.homemedia-clean-age')?.value) || 7,
                        http4khdhub: row.querySelector('.homemedia-http-4khdhub')?.checked ?? true,
                        httpUHDMovies: row.querySelector('.homemedia-http-uhdmovies')?.checked ?? true
                    });
                } else if (provider === 'httpstreaming') {
                    services.push({
                        provider,
                        http4khdhub: row.querySelector('.http-4khdhub')?.checked ?? true,
                        httpUHDMovies: row.querySelector('.http-uhdmovies')?.checked ?? true
                    });
                } else if (provider && apiKey) {
                    services.push({ provider, apiKey });
                }
            });
            return services;
        }
        
        function initLanguages() {
            const container = document.getElementById('languages-container');
            languages.forEach(lang => {
                const checked = existingLanguages.includes(lang.code) ? 'checked' : '';
                const label = document.createElement('label');
                label.className = 'flex items-center space-x-2 p-3 bg-[#0f1729] hover:bg-[#1a2332] rounded-lg cursor-pointer border border-[#2a3547]';
                label.innerHTML = \`
                    <input type="checkbox" value="\${lang.code}" class="checkbox-custom" \${checked}>
                    <span class="text-white text-base">\${lang.label}</span>
                \`;
                container.appendChild(label);
            });
        }
        
        function getSelectedLanguages() {
            const checkboxes = document.querySelectorAll('#languages-container input:checked');
            return Array.from(checkboxes).map(cb => cb.value);
        }
        
        function saveConfiguration() {
            reinstallAddon();
        }
        
        function copyManifestLinkAdvanced(event) {
            const services = getDebridServices();
            const languages = getSelectedLanguages();
            const minSize = parseInt(document.getElementById('minSize').value);
            const maxSize = parseInt(document.getElementById('maxSize').value);
            
            const config = { DebridServices: services, configStyle: 'advanced' };
            if (languages.length > 0) config.Languages = languages;
            if (minSize > 0 || maxSize < 200) {
                config.minSize = minSize;
                config.maxSize = maxSize;
            }
            
            const url = 'https://' + window.location.host + '/' + encodeURIComponent(JSON.stringify(config)) + '/manifest.json';
            
            navigator.clipboard.writeText(url).then(() => {
                const btn = event.target;
                const orig = btn.textContent;
                btn.textContent = '✓ Copied!';
                btn.classList.replace('text-gray-400', 'text-[#4ac4b1]');
                setTimeout(() => {
                    btn.textContent = orig;
                    btn.classList.replace('text-[#4ac4b1]', 'text-gray-400');
                }, 2000);
            }).catch(() => {
                const textArea = document.createElement('textarea');
                textArea.value = url;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                document.body.appendChild(textArea);
                textArea.select();
                try {
                    document.execCommand('copy');
                    const btn = event.target;
                    const orig = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    btn.classList.replace('text-gray-400', 'text-[#4ac4b1]');
                    setTimeout(() => {
                        btn.textContent = orig;
                        btn.classList.replace('text-[#4ac4b1]', 'text-gray-400');
                    }, 2000);
                } catch (err) {
                    alert('Failed to copy to clipboard');
                }
                document.body.removeChild(textArea);
            });
        }
        
        function reinstallAddon(event) {
            const btn = event?.currentTarget || event?.target;
            let orig, origClass;
            
            if (btn && btn.tagName === 'BUTTON') {
                orig = btn.textContent;
                origClass = btn.className;
                
                btn.textContent = 'Sending to Stremio...';
                btn.className = btn.className.replace(/bg-\[#4ac4b1\]|hover:bg-\[#4fd4c1\]|custom-btn/g, '').trim() + ' bg-gray-600 pointer-events-none text-white';
                
                setTimeout(() => btn.textContent = 'Sent!', 800);
                setTimeout(() => {
                    btn.textContent = orig;
                    btn.className = origClass;
                }, 2200);
            }
            
            setTimeout(() => {
                const modal = document.getElementById('modeSwitchModal');
                const isModalOpen = !modal.classList.contains('hidden');
                const targetMode = isModalOpen ? 'standard' : 'advanced';
                
                const services = getDebridServices();
                const languages = getSelectedLanguages();
                const minSize = parseInt(document.getElementById('minSize').value);
                const maxSize = parseInt(document.getElementById('maxSize').value);
                
                const config = { DebridServices: services, configStyle: targetMode };
            if (languages.length > 0) config.Languages = languages;
            if (minSize > 0 || maxSize < 200) {
                config.minSize = minSize;
                config.maxSize = maxSize;
            }
            
            const configStr = JSON.stringify(config);
            const encodedConfig = encodeURIComponent(configStr);
            const installUrl = \`stremio://\${window.location.host}/\${encodedConfig}/manifest.json\`;
            
            window.location.href = installUrl;
            }, btn ? 2400 : 0);
        }
        
        function switchToStandardMode() {
            document.getElementById('newModeName').textContent = 'Standard';
            document.getElementById('modeSwitchModal').classList.remove('hidden');
        }
        
        function closeModeSwitchModal() {
            const services = getDebridServices();
            const languages = getSelectedLanguages();
            const minSize = parseInt(document.getElementById('minSize').value);
            const maxSize = parseInt(document.getElementById('maxSize').value);
            
            const config = { DebridServices: services, configStyle: 'standard' };
            if (languages.length > 0) config.Languages = languages;
            if (minSize > 0 || maxSize < 200) {
                config.minSize = minSize;
                config.maxSize = maxSize;
            }
            
            const configStr = JSON.stringify(config);
            const encodedConfig = encodeURIComponent(configStr);
            window.location.href = \`/\${encodedConfig}/configure\`;
        }
        
        function reinstallFromModal() {
            reinstallAddon();
        }
        
        // Initialize
        existingServices.forEach(service => {
            addService(service.provider, service.apiKey, service);
        });
        
        if (existingServices.length === 0) {
            addService();
        }
        
        initLanguages();
        
        
        document.getElementById('min-value').textContent = document.getElementById('minSize').value;
        document.getElementById('max-value').textContent = document.getElementById('maxSize').value;
    </script>
</body>
</html>
    `;
}

function renderStandardConfigPage(manifest, config, logo) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${manifest.name} - Configuration</title>
    <link rel="icon" type="image/svg+xml" href="${logo}">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
        }
        
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        ::-webkit-scrollbar-track {
            background: #0a0a0a;
        }
        ::-webkit-scrollbar-thumb {
            background: #374151;
            border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: #4b5563;
        }
        * {
            scrollbar-width: thin;
            scrollbar-color: #374151 #0a0a0a;
        }
        
        input:focus, select:focus {
            outline: none;
            border-color: #4ac4b1;
            box-shadow: 0 0 0 3px rgba(100, 255, 218, 0.1);
        }
        
        select {
            padding-right: 2.5rem !important;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%2364ffda' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3E%3C/svg%3E");
            background-position: right 0.75rem center;
            background-repeat: no-repeat;
            background-size: 1.25em 1.25em;
            appearance: none;
            -webkit-appearance: none;
            -moz-appearance: none;
        }
        
        .checkbox-custom {
            appearance: none;
            width: 1.25rem;
            height: 1.25rem;
            border: 2px solid #4b5563;
            border-radius: 0.25rem;
            background: #111827;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .checkbox-custom:checked {
            background: #4ac4b1;
            border-color: #4ac4b1;
        }
        
        .checkbox-custom:checked::after {
            content: '✓';
            display: block;
            text-align: center;
            color: #0a0a0a;
            font-size: 0.875rem;
            line-height: 1.25rem;
            font-weight: bold;
        }
        
        .range-slider {
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 6px;
            background: #374151;
            outline: none;
            border-radius: 3px;
        }
        
        .range-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 18px;
            height: 18px;
            background: #4ac4b1;
            cursor: pointer;
            border-radius: 50%;
        }
        
        .range-slider::-moz-range-thumb {
            width: 18px;
            height: 18px;
            background: #4ac4b1;
            cursor: pointer;
            border-radius: 50%;
            border: none;
        }
        
        .custom-scrollbar::-webkit-scrollbar {
            width: 8px;
        }
        
        .custom-scrollbar::-webkit-scrollbar-track {
            background: #111827;
            border-radius: 4px;
        }
        
        .custom-scrollbar::-webkit-scrollbar-thumb {
            background: #374151;
            border-radius: 4px;
        }
        
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: #4b5563;
        }
        
        .custom-scrollbar {
            scrollbar-width: thin;
            scrollbar-color: #374151 #111827;
        }
        
        @media (max-width: 640px) {
            input[type="text"],
            select,
            textarea {
                font-size: 16px !important;
            }
            
            #servicesContainer {
                max-height: 380px !important;
            }
        }
        
        @supports (-webkit-touch-callout: none) {
            html {
                background: #0a0a0a;
                overflow-x: hidden;
            }
            
            body {
                background: #0a0a0a;
                position: relative;
                overflow-x: hidden;
            }
            
            body::before {
                content: '';
                position: fixed;
                top: -100vh;
                left: 0;
                right: 0;
                height: 100vh;
                background: #0a0a0a;
                z-index: -1;
            }
            
            body::after {
                content: '';
                position: fixed;
                bottom: -100vh;
                left: 0;
                right: 0;
                height: 100vh;
                background: #0a0a0a;
                z-index: -1;
            }
        }
    </style>
</head>
<body class="min-h-screen bg-gradient-to-b from-[#0a0a0a] via-[#111827] to-[#0a0a0a]">
    <div class="min-h-screen flex items-center justify-center p-4">
        <div class="w-full max-w-3xl">
            <!-- Header -->
            <div class="text-center mb-8">
                <img src="${logo}" alt="Sootio Logo" class="w-20 h-20 mx-auto mb-4">
                <h1 class="text-white text-3xl font-bold mb-2">${manifest.name}</h1>
                <p class="text-gray-400 text-sm">v${manifest.version || '0.0.0'}</p>
            </div>
            
            
            <div class="bg-[#1f2937] rounded-lg border border-gray-700 p-6 md:p-8 mb-6">
                <h2 class="text-white text-xl font-semibold mb-6">Configuration</h2>
                
                
                <div class="mb-6">
                    <label class="text-white font-medium mb-3 block">Debrid & Usenet Services</label>
                    <p class="text-gray-400 text-sm mb-4">Add one or more services. All will be queried simultaneously.</p>
                    <div id="servicesContainer" class="space-y-3 mb-4"></div>
                    <button onclick="addService()" class="w-full border-2 border-[#4ac4b1] text-[#4ac4b1] hover:bg-[#4ac4b1] hover:text-[#0a0a0a] transition-all rounded-lg py-2.5 font-medium text-sm">
                        + Add Service
                    </button>
                </div>
                
                
                <div class="mb-6">
                    <label class="text-white font-medium mb-3 block">Language Preferences (optional)</label>
                    <p class="text-gray-400 text-sm mb-4">Select preferred languages. If none selected, no language filter is applied.</p>
                    <div class="bg-[#111827] rounded-lg p-4 max-h-64 overflow-y-auto custom-scrollbar">
                        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3" id="languagesContainer"></div>
                    </div>
                </div>
                
                
                <div class="mb-6">
                    <label class="text-white font-medium mb-3 block">Filter by File Size (optional)</label>
                    <p class="text-gray-400 text-sm mb-4">Set minimum and maximum file size in GB. Set to 0-200 for no filtering.</p>
                    <div class="space-y-4">
                        <div>
                            <div class="flex justify-between mb-2">
                                <span class="text-gray-400 text-sm">Minimum:</span>
                                <span class="text-white font-semibold text-sm"><span id="minSizeValue">0</span> GB</span>
                            </div>
                            <input type="range" id="minSize" min="0" max="200" value="0" class="range-slider">
                        </div>
                        <div>
                            <div class="flex justify-between mb-2">
                                <span class="text-gray-400 text-sm">Maximum:</span>
                                <span class="text-white font-semibold text-sm"><span id="maxSizeValue">200</span> GB</span>
                            </div>
                            <input type="range" id="maxSize" min="0" max="200" value="200" class="range-slider">
                        </div>
                    </div>
                </div>
                
                
                <button onclick="reinstallAddon(event)" class="w-full bg-[#4ac4b1] hover:bg-[#4fd4c1] transition-colors text-[#0a0a0a] text-base font-bold rounded-lg py-3 mb-4">
                    Reinstall Sootio
                </button>
                
                <button onclick="copyManifestLink(event)" class="w-full text-gray-400 hover:text-[#4ac4b1] transition-colors text-sm py-2">
                   Copy Manifest Link
                </button>
            </div>
            
            <div class="text-center text-gray-600 text-sm mt-4">
                <a href="https://github.com/sooti/stremio-addon-debrid-search" target="_blank" class="hover:text-[#4ac4b1]">Report issues on Github</a>
                <span class="mx-2">•</span>
                <button onclick="switchToAdvancedMode()" class="hover:text-[#4ac4b1] inline-flex items-center">
                    <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                    </svg>
                    Advanced Mode
                </button>
            </div>
        </div>
    </div>
    
    <!-- Toast Notification -->
    <div id="toast" class="fixed bottom-8 left-1/2 transform -translate-x-1/2 bg-[#4ac4b1] text-[#0a0a0a] px-6 py-3 rounded-lg opacity-0 transition-opacity duration-300 pointer-events-none font-semibold">
        Configuration updated!
    </div>
    
    <div id="modeSwitchModal" onclick="if(event.target === this) closeModeSwitchModal()" class="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-[250] hidden">
        <div class="bg-[#1a2332] rounded-lg p-8 max-w-md mx-4 border-2 border-[#4ac4b1] shadow-2xl">
            <div class="text-center mb-6">
                <div class="inline-block p-3 bg-[#4ac4b1] bg-opacity-20 rounded-full mb-4">
                    <svg class="w-12 h-12 text-[#4ac4b1]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                    </svg>
                </div>
                <h3 class="text-white text-xl font-semibold mb-2">Configuration Style Updated</h3>
                <p class="text-gray-400 text-sm mb-6">You've switched to <span id="newModeName" class="text-[#4ac4b1] font-semibold"></span> mode. To save this preference, you need to reinstall the addon.</p>
            </div>
            <div class="flex gap-3">
                <button onclick="closeModeSwitchModal()" class="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors font-medium">
                    Later
                </button>
                <button onclick="reinstallFromModal()" class="flex-1 px-4 py-3 bg-[#4ac4b1] hover:bg-[#4fd4c1] text-[#0a0a0a] rounded-lg transition-colors font-semibold">
                    Reinstall Now
                </button>
            </div>
        </div>
    </div>
    
    <script>
        let serviceIndex = 0;
        
        const existingServices = ${JSON.stringify(config.DebridServices || (config.DebridProvider ? [{ provider: config.DebridProvider, apiKey: config.DebridApiKey }] : [{ provider: 'RealDebrid', apiKey: '' }]))};
        const existingLanguages = ${JSON.stringify(config.Languages || [])};
        const existingMinSize = ${config.minSize || 0};
        const existingMaxSize = ${config.maxSize || 200};
        
        const languages = [
            { code: 'en', label: '🇬🇧 English' },
            { code: 'fr', label: '🇫🇷 French' },
            { code: 'es', label: '🇪🇸 Spanish' },
            { code: 'de', label: '🇩🇪 German' },
            { code: 'it', label: '🇮🇹 Italian' },
            { code: 'pt', label: '🇵🇹 Portuguese' },
            { code: 'ru', label: '🇷🇺 Russian' },
            { code: 'hi', label: '🇮🇳 Hindi' },
            { code: 'ja', label: '🇯🇵 Japanese' },
            { code: 'ko', label: '🇰🇷 Korean' },
            { code: 'zh', label: '🇨🇳 Chinese' },
            { code: 'ar', label: '🇦🇪 Arabic' },
            { code: 'tr', label: '🇹🇷 Turkish' },
            { code: 'nl', label: '🇳🇱 Dutch' },
            { code: 'sv', label: '🇸🇪 Swedish' },
            { code: 'no', label: '🇳🇴 Norwegian' },
            { code: 'da', label: '🇩🇰 Danish' },
            { code: 'fi', label: '🇫🇮 Finnish' },
            { code: 'pl', label: '🇵🇱 Polish' },
            { code: 'cs', label: '🇨🇿 Czech' },
            { code: 'hu', label: '🇭🇺 Hungarian' },
            { code: 'ro', label: '🇷🇴 Romanian' },
            { code: 'el', label: '🇬🇷 Greek' },
            { code: 'he', label: '🇮🇱 Hebrew' },
            { code: 'th', label: '🇹🇭 Thai' },
            { code: 'ta', label: '🇮🇳 Tamil' },
            { code: 'ml', label: '🇮🇳 Malayalam' },
            { code: 'te', label: '🇮🇳 Telugu' },
            { code: 'kn', label: '🇮🇳 Kannada' },
            { code: 'es-419', label: '🇲🇽 Latino' }
        ];
        
        function addService(provider = 'RealDebrid', apiKey = '', extraConfig = {}) {
            const container = document.getElementById('servicesContainer');
            const index = serviceIndex++;
            
            const serviceRow = document.createElement('div');
            serviceRow.className = 'bg-[#111827] rounded-lg p-4';
            serviceRow.dataset.index = index;
            
            serviceRow.innerHTML = \`
                <div class="flex flex-col sm:flex-row gap-3">
                    <select class="debrid-provider flex-1 bg-[#0a0a0a] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm">
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
                    <div class="flex-1 flex gap-2">
                        <input type="text" placeholder="Enter API key" class="debrid-apikey flex-1 bg-[#0a0a0a] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm">
                        <a href="#" class="get-key-link text-[#4ac4b1] hover:text-[#4fd4c1] text-sm self-center whitespace-nowrap" target="_blank">Get key</a>
                    </div>
                    <button type="button" class="remove-service border border-red-500 text-red-500 hover:bg-red-500 hover:text-white transition-all rounded-lg px-4 py-2.5 text-sm font-medium">
                        Remove
                    </button>
                </div>
                <div class="service-config mt-3"></div>
            \`;
            
            container.appendChild(serviceRow);
            
            const select = serviceRow.querySelector('.debrid-provider');
            const input = serviceRow.querySelector('.debrid-apikey');
            const configDiv = serviceRow.querySelector('.service-config');
            const removeBtn = serviceRow.querySelector('.remove-service');
            const getKeyLink = serviceRow.querySelector('.get-key-link');
            
            select.value = provider;
            input.value = apiKey;
            
            function updateGetKeyLink() {
                const keyUrls = {
                    'RealDebrid': 'https://real-debrid.com/apitoken',
                    'TorBox': 'https://torbox.app/settings',
                    'AllDebrid': 'https://alldebrid.com/apikeys',
                    'Premiumize': 'https://www.premiumize.me/account',
                    'OffCloud': 'https://offcloud.com/#/account',
                    'DebriderApp': 'https://debrider.app/dashboard/account'
                };
                getKeyLink.href = keyUrls[select.value] || '#';
                getKeyLink.style.display = keyUrls[select.value] ? 'inline' : 'none';
            }
            
            updateGetKeyLink();
            
            function updateProviderFields() {
                configDiv.innerHTML = '';
                updateGetKeyLink();
                
                if (select.value === 'Usenet') {
                    input.placeholder = 'Newznab API Key';
                    input.style.display = '';
                    configDiv.innerHTML = \`
                        <input type="text" placeholder="Newznab URL" class="newznab-url w-full bg-[#0a0a0a] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.newznabUrl || ''}">
                        <input type="text" placeholder="SABnzbd URL" class="sabnzbd-url w-full bg-[#0a0a0a] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.sabnzbdUrl || ''}">
                        <input type="text" placeholder="SABnzbd API Key" class="sabnzbd-apikey w-full bg-[#0a0a0a] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.sabnzbdApiKey || ''}">
                        <input type="text" placeholder="File Server URL" class="file-server-url w-full bg-[#0a0a0a] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.fileServerUrl || ''}">
                        <input type="text" placeholder="File Server Password (Optional)" class="file-server-password w-full bg-[#0a0a0a] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.fileServerPassword || ''}">
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-4 mt-2 mb-2">
                            <div class="text-[#4ac4b1] font-semibold text-sm mb-3">Cleanup Options</div>
                            <label class="flex items-center space-x-2 mb-2 cursor-pointer">
                                <input type="checkbox" class="usenet-delete-on-stop checkbox-custom" \${extraConfig.deleteOnStreamStop ? 'checked' : ''}>
                                <span class="text-white text-sm">Delete file when stream stops</span>
                            </label>
                            <label class="flex items-center space-x-2 mb-2 cursor-pointer">
                                <input type="checkbox" class="usenet-auto-clean checkbox-custom" \${extraConfig.autoCleanOldFiles ? 'checked' : ''}>
                                <span class="text-white text-sm">Auto-clean old files</span>
                            </label>
                            <div class="flex items-center space-x-2 ml-6">
                                <label class="text-gray-400 text-sm">Days:</label>
                                <input type="number" class="usenet-clean-age bg-[#111827] border border-gray-600 rounded px-2 py-1 text-white text-sm w-20" min="1" max="365" value="\${extraConfig.autoCleanAgeDays || 7}">
                            </div>
                        </div>
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-4 mt-2">
                            <div class="text-[#4ac4b1] font-semibold text-sm mb-3">HTTP Streaming Sources</div>
                            <label class="flex items-center space-x-2 mb-2 cursor-pointer">
                                <input type="checkbox" class="usenet-http-4khdhub checkbox-custom" \${extraConfig.http4khdhub !== false ? 'checked' : ''}>
                                <span class="text-white text-sm">4KHDHub</span>
                            </label>
                            <label class="flex items-center space-x-2 cursor-pointer">
                                <input type="checkbox" class="usenet-http-uhdmovies checkbox-custom" \${extraConfig.httpUHDMovies !== false ? 'checked' : ''}>
                                <span class="text-white text-sm">UHDMovies</span>
                            </label>
                        </div>
                    \`;
                } else if (select.value === 'HomeMedia') {
                    input.placeholder = 'Home Media API Key (Optional)';
                    input.style.display = '';
                    configDiv.innerHTML = \`
                        <input type="text" placeholder="Home Media Server URL (e.g., http://localhost:3003)" class="homemedia-url w-full bg-[#0a0a0a] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.homeMediaUrl || ''}">
                        <p class="text-gray-400 text-xs mb-2">URL to your personal media file server - <a href="https://github.com/sooti/stremio-addon-debrid-search/tree/main/media-file-server" target="_blank" class="text-[#4ac4b1] hover:underline">Setup Guide</a></p>
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-4 mt-2 mb-2">
                            <div class="text-[#4ac4b1] font-semibold text-sm mb-3">Cleanup Options</div>
                            <label class="flex items-center space-x-2 mb-2 cursor-pointer">
                                <input type="checkbox" class="homemedia-delete-on-stop checkbox-custom" \${extraConfig.deleteOnStreamStop ? 'checked' : ''}>
                                <span class="text-white text-sm">Delete file when stream stops</span>
                            </label>
                            <label class="flex items-center space-x-2 mb-2 cursor-pointer">
                                <input type="checkbox" class="homemedia-auto-clean checkbox-custom" \${extraConfig.autoCleanOldFiles ? 'checked' : ''}>
                                <span class="text-white text-sm">Auto-clean old files</span>
                            </label>
                            <div class="flex items-center space-x-2 ml-6">
                                <label class="text-gray-400 text-sm">Days:</label>
                                <input type="number" class="homemedia-clean-age bg-[#111827] border border-gray-600 rounded px-2 py-1 text-white text-sm w-20" min="1" max="365" value="\${extraConfig.autoCleanAgeDays || 7}">
                            </div>
                        </div>
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-4 mt-2">
                            <div class="text-[#4ac4b1] font-semibold text-sm mb-3">HTTP Streaming Sources</div>
                            <label class="flex items-center space-x-2 mb-2 cursor-pointer">
                                <input type="checkbox" class="homemedia-http-4khdhub checkbox-custom" \${extraConfig.http4khdhub !== false ? 'checked' : ''}>
                                <span class="text-white text-sm">4KHDHub</span>
                            </label>
                            <label class="flex items-center space-x-2 cursor-pointer">
                                <input type="checkbox" class="homemedia-http-uhdmovies checkbox-custom" \${extraConfig.httpUHDMovies !== false ? 'checked' : ''}>
                                <span class="text-white text-sm">UHDMovies</span>
                            </label>
                        </div>
                    \`;
                } else if (select.value === 'httpstreaming') {
                    input.style.display = 'none';
                    configDiv.innerHTML = \`
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-4 mt-2">
                            <div class="text-[#4ac4b1] font-semibold text-sm mb-3">HTTP Streaming Sources</div>
                            <label class="flex items-center space-x-2 mb-2 cursor-pointer">
                                <input type="checkbox" class="http-4khdhub checkbox-custom" \${extraConfig.http4khdhub !== false ? 'checked' : ''}>
                                <span class="text-white text-sm">4KHDHub</span>
                            </label>
                            <label class="flex items-center space-x-2 cursor-pointer">
                                <input type="checkbox" class="http-uhdmovies checkbox-custom" \${extraConfig.httpUHDMovies !== false ? 'checked' : ''}>
                                <span class="text-white text-sm">UHDMovies</span>
                            </label>
                        </div>
                    \`;
                } else {
                    input.style.display = '';
                    input.placeholder = 'Enter API key';
                }
                
                configDiv.querySelectorAll('input').forEach(inp => {
                    inp.addEventListener('input', updateLink);
                    inp.addEventListener('change', updateLink);
                });
                updateLink();
            }
            
            select.addEventListener('change', updateProviderFields);
            input.addEventListener('input', updateLink);
            removeBtn.addEventListener('click', () => {
                serviceRow.remove();
                updateLink();
            });
            
            updateProviderFields();
            
            if (extraConfig.newznabUrl || extraConfig.sabnzbdUrl || extraConfig.homeMediaUrl) {
                updateProviderFields();
            }
        }
        
        function initLanguages() {
            const container = document.getElementById('languagesContainer');
            languages.forEach(lang => {
                const checked = existingLanguages.includes(lang.code) ? 'checked' : '';
                const label = document.createElement('label');
                label.className = 'flex items-center space-x-2 p-2 hover:bg-[#1f2937] rounded cursor-pointer';
                label.innerHTML = \`
                    <input type="checkbox" value="\${lang.code}" class="checkbox-custom" \${checked}>
                    <span class="text-white text-sm">\${lang.label}</span>
                \`;
                label.querySelector('input').addEventListener('change', updateLink);
                container.appendChild(label);
            });
        }
        
        function getDebridServices() {
            const services = [];
            const rows = document.querySelectorAll('#servicesContainer [data-index]');
            rows.forEach(row => {
                const provider = row.querySelector('.debrid-provider').value;
                const apiKey = row.querySelector('.debrid-apikey').value;
                
                if (provider === 'Usenet') {
                    services.push({
                        provider,
                        apiKey,
                        newznabUrl: row.querySelector('.newznab-url')?.value || '',
                        sabnzbdUrl: row.querySelector('.sabnzbd-url')?.value || '',
                        sabnzbdApiKey: row.querySelector('.sabnzbd-apikey')?.value || '',
                        fileServerUrl: row.querySelector('.file-server-url')?.value || '',
                        fileServerPassword: row.querySelector('.file-server-password')?.value || '',
                        deleteOnStreamStop: row.querySelector('.usenet-delete-on-stop')?.checked || false,
                        autoCleanOldFiles: row.querySelector('.usenet-auto-clean')?.checked || false,
                        autoCleanAgeDays: parseInt(row.querySelector('.usenet-clean-age')?.value) || 7,
                        http4khdhub: row.querySelector('.usenet-http-4khdhub')?.checked ?? true,
                        httpUHDMovies: row.querySelector('.usenet-http-uhdmovies')?.checked ?? true
                    });
                } else if (provider === 'HomeMedia') {
                    services.push({
                        provider,
                        apiKey: apiKey || '',
                        homeMediaUrl: row.querySelector('.homemedia-url')?.value || '',
                        deleteOnStreamStop: row.querySelector('.homemedia-delete-on-stop')?.checked || false,
                        autoCleanOldFiles: row.querySelector('.homemedia-auto-clean')?.checked || false,
                        autoCleanAgeDays: parseInt(row.querySelector('.homemedia-clean-age')?.value) || 7,
                        http4khdhub: row.querySelector('.homemedia-http-4khdhub')?.checked ?? true,
                        httpUHDMovies: row.querySelector('.homemedia-http-uhdmovies')?.checked ?? true
                    });
                } else if (provider === 'httpstreaming') {
                    services.push({
                        provider,
                        http4khdhub: row.querySelector('.http-4khdhub')?.checked ?? true,
                        httpUHDMovies: row.querySelector('.http-uhdmovies')?.checked ?? true
                    });
                } else if (provider && apiKey) {
                    services.push({ provider, apiKey });
                }
            });
            return services;
        }
        
        function getSelectedLanguages() {
            const checkboxes = document.querySelectorAll('#languagesContainer input:checked');
            return Array.from(checkboxes).map(cb => cb.value);
        }
        
        function updateLink() {
            const services = getDebridServices();
            const languages = getSelectedLanguages();
            const minSize = parseInt(document.getElementById('minSize')?.value || 0);
            const maxSize = parseInt(document.getElementById('maxSize')?.value || 200);
            
            const config = { DebridServices: services, configStyle: 'standard' };
            if (languages.length > 0) config.Languages = languages;
            if (minSize > 0 || maxSize < 200) {
                config.minSize = minSize;
                config.maxSize = maxSize;
            }
        }
        
        function reinstallAddon(event) {
            const btn = event?.currentTarget || event?.target;
            let orig, origClass;
            
            if (btn && btn.tagName === 'BUTTON') {
                orig = btn.textContent;
                origClass = btn.className;
                
                btn.textContent = 'Sending to Stremio...';
                btn.className = btn.className.replace(/bg-\[#4ac4b1\]|hover:bg-\[#4fd4c1\]/g, '').trim() + ' bg-gray-600 pointer-events-none text-white';
                
                setTimeout(() => btn.textContent = 'Sent!', 800);
                setTimeout(() => {
                    btn.textContent = orig;
                    btn.className = origClass;
                }, 2200);
            }
            
            setTimeout(() => {
                const modal = document.getElementById('modeSwitchModal');
                const isModalOpen = !modal.classList.contains('hidden');
                const targetMode = isModalOpen ? 'advanced' : 'standard';
                
            const services = getDebridServices();
            const languages = getSelectedLanguages();
            const minSize = parseInt(document.getElementById('minSize').value);
            const maxSize = parseInt(document.getElementById('maxSize').value);
            
                const config = { DebridServices: services, configStyle: targetMode };
            if (languages.length > 0) config.Languages = languages;
            if (minSize > 0 || maxSize < 200) {
                config.minSize = minSize;
                config.maxSize = maxSize;
            }
            
            const configStr = JSON.stringify(config);
            const encodedConfig = encodeURIComponent(configStr);
            const installUrl = \`stremio://\${window.location.host}/\${encodedConfig}/manifest.json\`;
            
            window.location.href = installUrl;
            }, btn ? 2400 : 0);
        }
        
        function switchToAdvancedMode() {
            document.getElementById('newModeName').textContent = 'Advanced';
            document.getElementById('modeSwitchModal').classList.remove('hidden');
        }
        
        function closeModeSwitchModal() {
            const services = getDebridServices();
            const languages = getSelectedLanguages();
            const minSize = parseInt(document.getElementById('minSize').value);
            const maxSize = parseInt(document.getElementById('maxSize').value);
            
            const config = { DebridServices: services, configStyle: 'advanced' };
            if (languages.length > 0) config.Languages = languages;
            if (minSize > 0 || maxSize < 200) {
                config.minSize = minSize;
                config.maxSize = maxSize;
            }
            
            const configStr = JSON.stringify(config);
            const encodedConfig = encodeURIComponent(configStr);
            window.location.href = \`/\${encodedConfig}/configure\`;
        }
        
        function reinstallFromModal() {
            reinstallAddon();
        }
        
        function copyManifestLink(event) {
            const services = getDebridServices();
            const languages = getSelectedLanguages();
            const minSize = parseInt(document.getElementById('minSize').value);
            const maxSize = parseInt(document.getElementById('maxSize').value);
            
            const config = { DebridServices: services, configStyle: 'standard' };
            if (languages.length > 0) config.Languages = languages;
            if (minSize > 0 || maxSize < 200) {
                config.minSize = minSize;
                config.maxSize = maxSize;
            }
            
            const url = 'https://' + window.location.host + '/' + encodeURIComponent(JSON.stringify(config)) + '/manifest.json';
            
            navigator.clipboard.writeText(url).then(() => {
                const btn = event.target;
                const orig = btn.textContent;
                btn.textContent = '✓ Copied!';
                btn.classList.replace('text-gray-400', 'text-[#4ac4b1]');
                setTimeout(() => {
                    btn.textContent = orig;
                    btn.classList.replace('text-[#4ac4b1]', 'text-gray-400');
                }, 2000);
            }).catch(() => {
                const textArea = document.createElement('textarea');
                textArea.value = url;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                document.body.appendChild(textArea);
                textArea.select();
                try {
                    document.execCommand('copy');
                    const btn = event.target;
                    const orig = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    btn.classList.replace('text-gray-400', 'text-[#4ac4b1]');
                    setTimeout(() => {
                        btn.textContent = orig;
                        btn.classList.replace('text-[#4ac4b1]', 'text-gray-400');
                    }, 2000);
                } catch (err) {
                    alert('Failed to copy to clipboard');
                }
                document.body.removeChild(textArea);
            });
        }
        
        // Initialize
        existingServices.forEach(service => {
            addService(service.provider, service.apiKey, service);
        });
        
        if (existingServices.length === 0) {
            addService();
        }
        
        initLanguages();
        
        document.getElementById('minSize').value = existingMinSize;
        document.getElementById('maxSize').value = existingMaxSize;
        document.getElementById('minSizeValue').textContent = existingMinSize;
        document.getElementById('maxSizeValue').textContent = existingMaxSize;
        
        document.getElementById('minSize').addEventListener('input', function() {
            let minVal = parseInt(this.value);
            let maxVal = parseInt(document.getElementById('maxSize').value);
            if (minVal > maxVal) {
                this.value = maxVal;
                minVal = maxVal;
            }
            document.getElementById('minSizeValue').textContent = minVal;
            updateLink();
        });
        
        document.getElementById('maxSize').addEventListener('input', function() {
            let minVal = parseInt(document.getElementById('minSize').value);
            let maxVal = parseInt(this.value);
            if (maxVal < minVal) {
                this.value = minVal;
                maxVal = minVal;
            }
            document.getElementById('maxSizeValue').textContent = maxVal;
            updateLink();
        });
        
        updateLink();
    </script>
</body>
</html>
    `;
}

function landingTemplateNew(manifest, config) {
    const logo = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%2364ffda;stop-opacity:1' /%3E%3Cstop offset='100%25' style='stop-color:%2300A7B5;stop-opacity:1' /%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath fill='url(%23grad)' d='M50,5 C74.85,5 95,25.15 95,50 C95,74.85 74.85,95 50,95 C35,95 22.33,87.6 15,76 C25,85 40,85 50,80 C60,75 65,65 65,50 C65,35 55,25 40,25 C25,25 15,40 15,50 C15,55 16,60 18,64 C8.5,58 5,45 5,50 C5,25.15 25.15,5 50,5 Z'/%3E%3C/svg%3E";
    
    // Check if user already has a configuration
    const hasExistingConfig = config && (
        (config.DebridServices && Array.isArray(config.DebridServices) && config.DebridServices.length > 0) ||
        (config.DebridProvider && config.DebridApiKey)
    );
    
    // If user has existing config, show the appropriate configuration page
    if (hasExistingConfig) {
        // Check if they want advanced mode
        if (config.configStyle === 'advanced') {
            return renderAdvancedConfigPage(manifest, config, logo);
        }
        return renderStandardConfigPage(manifest, config, logo);
    }

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${manifest.name} - Configuration</title>
    <link rel="icon" type="image/svg+xml" href="${logo}">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
        }
        
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        ::-webkit-scrollbar-track {
            background: #0a0a0a;
        }
        ::-webkit-scrollbar-thumb {
            background: #374151;
            border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: #4b5563;
        }
        * {
            scrollbar-width: thin;
            scrollbar-color: #374151 #0a0a0a;
        }
        
        .stars {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            opacity: 0.6;
        }
        
        .star {
            position: absolute;
            background: white;
            border-radius: 50%;
            animation: twinkle 3s infinite;
        }
        
        @keyframes twinkle {
            0%, 100% { opacity: 0.3; } 50% { opacity: 0.8; }
        }
        
        @keyframes fillLogo {
            from { opacity: 0.2; transform: scale(0.9); }
            to { opacity: 1; transform: scale(1); }
        }
        
        .logo-loading {
            animation: fillLogo 2s ease-out forwards;
        }
        
        @keyframes cardIn {
            from { opacity: 0; transform: scale(1.05) translateZ(50px); }
            to { opacity: 1; transform: scale(1) translateZ(0); }
        }
        
        .card-in {
            animation: cardIn 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        
        @keyframes slideDown {
            from {
                opacity: 0;
                transform: translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .slide-down {
            animation: slideDown 0.4s ease-out forwards;
        }
        
        .service-row {
            transition: all 0.3s ease;
        }
        
        .service-row:hover {
            background: rgba(99, 102, 241, 0.05);
        }
        
        input:focus, select:focus {
            outline: none;
            border-color: #4ac4b1;
            box-shadow: 0 0 0 3px rgba(100, 255, 218, 0.1);
        }
        
        .checkbox-custom {
            appearance: none;
            width: 1.25rem;
            height: 1.25rem;
            border: 2px solid #4b5563;
            border-radius: 0.25rem;
            background: #111827;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .checkbox-custom:checked {
            background: #4ac4b1;
            border-color: #4ac4b1;
        }
        
        .checkbox-custom:checked::after {
            content: '✓';
            display: block;
            text-align: center;
            color: #0a0a0a;
            font-size: 0.875rem;
            line-height: 1.25rem;
        }
        
        .range-slider {
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 6px;
            background: #374151;
            outline: none;
            border-radius: 3px;
        }
        
        .range-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 18px;
            height: 18px;
            background: #4ac4b1;
            cursor: pointer;
            border-radius: 50%;
        }
        
        .range-slider::-moz-range-thumb {
            width: 18px;
            height: 18px;
            background: #4ac4b1;
            cursor: pointer;
            border-radius: 50%;
            border: none;
        }
        
        .step-indicator {
            transition: all 0.3s ease;
        }
        
        .step-indicator.active {
            background: #4ac4b1;
            transform: scale(1.2);
        }
        
        .step-indicator.completed {
            background: #4ac4b1;
        }
        
        .tooltip {
            position: relative;
            display: inline-block;
            cursor: help;
        }
        
        .tooltip .tooltiptext {
            visibility: hidden;
            width: 200px;
            background-color: #1f2937;
            color: #fff;
            text-align: center;
            border-radius: 6px;
            padding: 8px 10px;
            position: absolute;
            z-index: 1000;
            bottom: 125%;
            left: 50%;
            transform: translateX(-50%);
            opacity: 0;
            transition: opacity 0.3s;
            font-size: 0.75rem;
            border: 1px solid #374151;
            white-space: normal;
            pointer-events: none;
        }
        
        @media (max-width: 640px) {
            .tooltip .tooltiptext {
                width: 220px;
                max-width: calc(100vw - 40px);
                font-size: 0.7rem;
                padding: 6px 8px;
                bottom: 150%;
                left: auto;
                right: -10px;
                transform: translateX(0);
            }
            
            .tooltip .tooltiptext::after {
                left: auto;
                right: 20px;
            }
            
            #step1 .config-style-card {
                max-height: 200px;
            }
            
            #step1 .config-style-card > div:first-child {
                height: 100px !important;
                min-height: 100px !important;
            }
            
            #step1 .config-style-card .p-3 {
                padding: 0.5rem !important;
            }
            
            #step1 h3 {
                font-size: 0.875rem !important;
                margin-bottom: 0.25rem !important;
            }
            
            #step1 p.text-gray-400 {
                font-size: 0.7rem !important;
            }
            
            #step1 .mb-6 {
                margin-bottom: 1rem !important;
            }
            
            #step1 button.mb-16 {
                margin-bottom: 5rem !important;
            }
            
            #step1 .gap-4 {
                gap: 0.75rem !important;
            }
            
            #step1 h1 {
                font-size: 1.125rem !important;
                margin-bottom: 0.5rem !important;
            }
            
            #step1 .mb-6.sm\:mb-10:first-of-type {
                margin-bottom: 0.75rem !important;
            }
            
            #step2 h2 {
                font-size: 1.25rem !important;
                margin-bottom: 0.5rem !important;
            }
            
            #step2 p.text-gray-400 {
                margin-bottom: 1rem !important;
            }
            
            #servicesContainer {
                max-height: 380px !important;
            }
            
            input[type="text"],
            select,
            textarea {
                font-size: 16px !important;
            }
            
            #step2 .mb-8 {
                margin-bottom: 1.5rem !important;
            }
        }
        
        @supports (-webkit-touch-callout: none) {
            html {
                background: #0a0a0a;
                overflow-x: hidden;
            }
            
            body {
                background: #0a0a0a;
                position: relative;
                overflow-x: hidden;
            }
            
            body::before {
                content: '';
                position: fixed;
                top: -100vh;
                left: 0;
                right: 0;
                height: 100vh;
                background: #0a0a0a;
                z-index: -1;
            }
            
            body::after {
                content: '';
                position: fixed;
                bottom: -100vh;
                left: 0;
                right: 0;
                height: 100vh;
                background: #0a0a0a;
                z-index: -1;
            }
        }
        
        .tooltip .tooltiptext::after {
            content: "";
            position: absolute;
            top: 100%;
            left: 50%;
            margin-left: -5px;
            border-width: 5px;
            border-style: solid;
            border-color: #1f2937 transparent transparent transparent;
        }
        
        .tooltip:hover .tooltiptext,
        .tooltip:active .tooltiptext,
        .tooltip.tooltip-show .tooltiptext {
            visibility: visible;
            opacity: 1;
        }
        
        @media (max-width: 640px) {
            .tooltip .tooltiptext {
                pointer-events: auto;
            }
        }
        
        #servicesContainer::-webkit-scrollbar {
            width: 8px;
        }
        
        #servicesContainer::-webkit-scrollbar-track {
            background: #1f2937;
            border-radius: 4px;
        }
        
        #servicesContainer::-webkit-scrollbar-thumb {
            background: #4b5563;
            border-radius: 4px;
        }
        
        #servicesContainer::-webkit-scrollbar-thumb:hover {
            background: #6b7280;
        }
        
       
        select {
            padding-right: 2.5rem !important;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%2364ffda' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3E%3C/svg%3E");
            background-position: right 0.75rem center;
            background-repeat: no-repeat;
            background-size: 1.25em 1.25em;
            appearance: none;
            -webkit-appearance: none;
            -moz-appearance: none;
        }
        
       
        .custom-scrollbar::-webkit-scrollbar {
            width: 8px;
        }
        
        .custom-scrollbar::-webkit-scrollbar-track {
            background: #111827;
            border-radius: 4px;
        }
        
        .custom-scrollbar::-webkit-scrollbar-thumb {
            background: #374151;
            border-radius: 4px;
        }
        
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: #4b5563;
        }
        
        /* Firefox scrollbar */
        .custom-scrollbar {
            scrollbar-width: thin;
            scrollbar-color: #374151 #111827;
        }
        
        /* Accessibility */
        button:focus,
        a:focus,
        input:focus,
        select:focus,
        textarea:focus {
            outline: 3px solid rgba(100, 255, 218, 0.5);
            outline-offset: 2px;
        }
        
        button:focus:not(:focus-visible),
        a:focus:not(:focus-visible),
        input:focus:not(:focus-visible),
        select:focus:not(:focus-visible),
        textarea:focus:not(:focus-visible) {
            outline: none;
        }
        
        /* Screen reader only  */
        .sr-only {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border-width: 0;
        }
    </style>
</head>
<body class="min-h-screen bg-gradient-to-b from-[#0a0a0a] via-[#111827] to-[#0a0a0a]">
    
    <div id="starsContainer" class="stars"></div>
    
    <div id="loadingScreen" class="fixed inset-0 flex items-center justify-center z-50">
        <img src="${logo}" alt="Sootio Logo" class="w-32 h-32 logo-loading" id="loadingLogo">
    </div>
    
    <div id="mainContent" class="hidden min-h-screen flex flex-col items-center justify-center p-4 relative">
        <div class="w-full max-w-2xl flex-1 flex items-center justify-center">
            
            <div id="step0" class="step-content flex flex-col items-center justify-center min-h-[80vh]">
                <div class="flex flex-col items-center text-center flex-1 flex items-center justify-center">
                    <img src="${logo}" alt="Sootio Logo" class="w-24 h-24 rounded-2xl mb-6">
                    <h1 class="text-white text-5xl font-bold mb-4">Welcome to Sootio</h1>
                    <p class="text-gray-400 text-lg mb-8">Your ultimate debrid companion</p>
                    <button onclick="nextStep()" class="bg-[#4ac4b1] hover:bg-[#4fd4c1] transition-colors text-[#0a0a0a] text-base font-semibold rounded-lg px-16 py-4">
                        Get Started
                    </button>
                </div>
                <div class="flex-shrink-0 mt-16">
                    <p class="text-gray-400 text-sm text-center opacity-80">If you have already configured, your settings will autopopulate.</p>
                </div>
            </div>
            
            <!-- Step 1: Choose Configuration Style -->
            <div id="step1" class="step-content hidden">
                <div class="flex flex-col items-center px-4">
                    <h1 class="text-white text-xl sm:text-2xl font-semibold mb-3 text-center">Choose your configuration style</h1>
                    <div class="flex items-center justify-center gap-2 mb-6 sm:mb-10">
                        <p class="text-gray-400 text-sm sm:text-base text-center">Select the configuration interface that works best for you.</p>
                        <div class="tooltip">
                            <svg class="w-4 h-4 text-gray-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
                            </svg>
                            <span class="tooltiptext">You can always change this setting at any time</span>
                        </div>
                    </div>
                    
                    <div class="flex flex-col sm:flex-row gap-4 mb-6 sm:mb-10 w-full max-w-4xl">
                        <!-- Standard Option (Selected by default) -->
                        <div onclick="selectConfigStyle('standard')" class="config-style-card flex-1 bg-[#1a1f2e] rounded-lg cursor-pointer border-2 border-[#4ac4b1] hover:border-[#4fd4c1] transition-all overflow-hidden shadow-lg">
                            <div class="w-full h-40 sm:h-48 flex items-center justify-center bg-[#0f1419] p-2">
                                <img src="https://spooky.host/sootiostandard.png" alt="Standard Configuration Preview" class="w-full h-full object-contain">
                            </div>
                            <div class="p-3 sm:p-4 text-center">
                                <h3 class="text-white text-base sm:text-lg font-semibold mb-1 sm:mb-2">Standard</h3>
                                <p class="text-gray-400 text-xs sm:text-sm">Classic single-page layout with all options visible</p>
                            </div>
                        </div>
                        
                        <!-- Advanced Option -->
                        <div onclick="selectConfigStyle('advanced')" class="config-style-card flex-1 bg-[#1a1f2e] rounded-lg cursor-pointer border-2 border-gray-700 hover:border-[#4ac4b1] transition-all overflow-hidden shadow-lg">
                            <div class="w-full h-40 sm:h-48 flex items-center justify-center bg-[#0f1419] p-2">
                                <img src="https://spooky.host/sootioadvanced.png" alt="Advanced Configuration Preview" class="w-full h-full object-contain">
                            </div>
                            <div class="p-3 sm:p-4 text-center">
                                <h3 class="text-white text-base sm:text-lg font-semibold mb-1 sm:mb-2">Advanced</h3>
                                <p class="text-gray-400 text-xs sm:text-sm">Dashboard-style interface with organized sections</p>
                            </div>
                        </div>
                    </div>
                    
                    <button onclick="nextStep()" class="bg-[#4ac4b1] hover:bg-[#4fd4c1] transition-colors text-[#0a0a0a] text-base font-semibold rounded-lg px-12 py-3 mb-16 sm:mb-0">
                        Continue
                    </button>
                </div>
            </div>
            
            <!-- Step 2: Debrid & Usenet Services -->
            <div id="step2" class="step-content hidden">
                <div class="max-w-2xl mx-auto">
                    <h2 class="text-white text-2xl font-semibold mb-2 text-center">Debrid & Usenet Services</h2>
                    <p class="text-gray-400 text-sm mb-8 text-center">Add one or more services. All will be queried simultaneously.</p>
                    
                    <div id="servicesContainer" class="space-y-3 mb-6 max-h-[60vh] overflow-y-auto pr-2" style="scrollbar-width: thin; scrollbar-color: #4b5563 #1f2937;"></div>
                    
                    <button onclick="addService()" class="w-full border-2 border-[#4ac4b1] text-[#4ac4b1] hover:bg-[#4ac4b1] hover:text-[#0a0a0a] transition-all rounded-lg py-3 font-medium mb-8">
                        + Add Service
                    </button>
                    
                    <div class="flex justify-between">
                        <button onclick="prevStep()" class="text-gray-400 hover:text-[#4ac4b1] transition-colors px-6 py-3">
                            ← Back
                        </button>
                        <button onclick="nextStep()" class="bg-[#4ac4b1] hover:bg-[#4fd4c1] transition-colors text-[#0a0a0a] font-semibold rounded-lg px-12 py-3">
                            Continue
                        </button>
                    </div>
                </div>
            </div>
            
            <!-- Step 3: Language Preferences -->
            <div id="step3" class="step-content hidden">
                <div class="max-w-2xl mx-auto">
                    <h2 class="text-white text-2xl font-semibold mb-2 text-center">Language Preferences</h2>
                    <p class="text-gray-400 text-sm mb-8 text-center">Select preferred languages. If none selected, no language filter is applied.</p>
                    
                    <div class="bg-[#1f2937] rounded-lg p-6 mb-8 max-h-96 overflow-y-auto custom-scrollbar">
                        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3" id="languagesContainer">
                            <!-- Languages will be populated here -->
                        </div>
                    </div>
                    
                    <div class="flex justify-between">
                        <button onclick="prevStep()" class="text-gray-400 hover:text-[#4ac4b1] transition-colors px-6 py-3">
                            ← Back
                        </button>
                        <button onclick="nextStep()" class="bg-[#4ac4b1] hover:bg-[#4fd4c1] transition-colors text-[#0a0a0a] font-semibold rounded-lg px-12 py-3">
                            Continue
                        </button>
                    </div>
                </div>
            </div>
            
            <!-- Step 4: File Size Filter -->
            <div id="step4" class="step-content hidden">
                <div class="max-w-2xl mx-auto">
                    <h2 class="text-white text-2xl font-semibold mb-2 text-center">Filter by File Size</h2>
                    <p class="text-gray-400 text-sm mb-8 text-center">Set minimum and maximum file size in GB. Set to 0-200 for no filtering.</p>
                    
                    <div class="bg-[#1f2937] rounded-lg p-8 mb-8">
                        <div class="space-y-8">
                            <div>
                                <div class="flex justify-between mb-3">
                                    <label class="text-gray-400 text-sm">Minimum Size:</label>
                                    <span class="text-white font-semibold"><span id="minSizeValue">0</span> GB</span>
                                </div>
                                <input type="range" id="minSize" min="0" max="200" value="0" class="range-slider">
                            </div>
                            <div>
                                <div class="flex justify-between mb-3">
                                    <label class="text-gray-400 text-sm">Maximum Size:</label>
                                    <span class="text-white font-semibold"><span id="maxSizeValue">200</span> GB</span>
                                </div>
                                <input type="range" id="maxSize" min="0" max="200" value="200" class="range-slider">
                            </div>
                        </div>
                    </div>
                    
                    <div class="flex justify-between">
                        <button onclick="prevStep()" class="text-gray-400 hover:text-[#4ac4b1] transition-colors px-6 py-3">
                            ← Back
                        </button>
                        <button onclick="nextStep()" class="bg-[#4ac4b1] hover:bg-[#4fd4c1] transition-colors text-[#0a0a0a] font-semibold rounded-lg px-12 py-3">
                            Continue
                        </button>
                    </div>
                </div>
            </div>
            
            <!-- Step 5: Completion -->
            <div id="step5" class="step-content hidden">
                <div class="max-w-2xl mx-auto text-center">
                    <div class="text-6xl mb-6">🎉</div>
                    <h2 class="text-white text-3xl font-bold mb-6">Configuration Complete!</h2>
                    <p class="text-gray-400 text-lg mb-12">Your Sootio addon is ready to install.</p>
                    
                    <div class="flex flex-col items-center space-y-4 mb-12">
                        <button id="installBtn" class="bg-[#4ac4b1] hover:bg-[#4fd4c1] transition-colors text-[#0a0a0a] text-lg font-bold rounded-lg px-16 py-4 cursor-pointer">
                            INSTALL ADDON
                        </button>
                    
                        <button onclick="copyManifestLink()" class="text-gray-500 hover:text-[#4ac4b1] transition-colors text-sm font-medium">
                        Copy Manifest Link
                    </button>
                    </div>
                    
                    <button onclick="prevStep()" class="text-gray-400 hover:text-[#4ac4b1] transition-colors text-sm">
                        ← Go Back
                    </button>
                    
                    <p class="text-gray-500 text-sm mt-8">
                        Report issues on <a href="https://github.com/sooti/stremio-addon-debrid-search" target="_blank" class="text-[#4ac4b1] hover:underline">Github</a>
                    </p>
                </div>
            </div>
            
        </div>

        <!-- Step Indicators  -->
        <div id="stepIndicators" class="hidden fixed bottom-6 sm:bottom-10 left-1/2 transform -translate-x-1/2 flex justify-center items-center space-x-3 z-50">
            <span class="step-indicator w-2 h-2 rounded-full bg-gray-600 block" data-step="0"></span>
            <span class="step-indicator w-2 h-2 rounded-full bg-gray-600 block" data-step="1"></span>
            <span class="step-indicator w-2 h-2 rounded-full bg-gray-600 block" data-step="2"></span>
            <span class="step-indicator w-2 h-2 rounded-full bg-gray-600 block" data-step="3"></span>
            <span class="step-indicator w-2 h-2 rounded-full bg-gray-600 block" data-step="4"></span>
            <span class="step-indicator w-2 h-2 rounded-full bg-gray-600 block" data-step="5"></span>
        </div>
    </div>
    
    <div id="toast" class="fixed bottom-8 left-1/2 transform -translate-x-1/2 bg-[#4ac4b1] text-[#0a0a0a] px-6 py-3 rounded-lg opacity-0 transition-opacity duration-300 pointer-events-none font-semibold text-sm sm:text-base whitespace-nowrap max-w-[90vw] overflow-hidden text-ellipsis">
        Manifest link copied!
    </div>
    
    <div id="validationModal" onclick="if(event.target === this) closeValidationModal()" class="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 hidden backdrop-blur-sm">
        <div class="bg-[#1a1f2e] rounded-2xl p-6 max-w-xs mx-4 shadow-xl border border-gray-800">
            <p class="text-white text-[15px] font-normal text-center mb-5 leading-relaxed">Add a service to continue</p>
            <button onclick="closeValidationModal()" class="w-full px-4 py-2.5 bg-[#4ac4b1] hover:bg-[#4fd4c1] text-[#0a0a0a] rounded-lg transition-all font-medium text-[15px]">
                OK
            </button>
        </div>
    </div>
    
    <script>
        let currentStep = 0;
        let configStyle = '${config.configStyle || 'standard'}';
        let serviceIndex = 0;
        
        // Initialize with existing config or default
        const existingServices = ${JSON.stringify(config.DebridServices || (config.DebridProvider ? [{ provider: config.DebridProvider, apiKey: config.DebridApiKey }] : [{ provider: 'RealDebrid', apiKey: '' }]))};
        const existingLanguages = ${JSON.stringify(config.Languages || [])};
        const existingMinSize = ${config.minSize || 0};
        const existingMaxSize = ${config.maxSize || 200};
        
        const languages = [
            { code: 'en', label: '🇬🇧 English' },
            { code: 'fr', label: '🇫🇷 French' },
            { code: 'es', label: '🇪🇸 Spanish' },
            { code: 'de', label: '🇩🇪 German' },
            { code: 'it', label: '🇮🇹 Italian' },
            { code: 'pt', label: '🇵🇹 Portuguese' },
            { code: 'ru', label: '🇷🇺 Russian' },
            { code: 'hi', label: '🇮🇳 Hindi' },
            { code: 'ja', label: '🇯🇵 Japanese' },
            { code: 'ko', label: '🇰🇷 Korean' },
            { code: 'zh', label: '🇨🇳 Chinese' },
            { code: 'ar', label: '🇦🇪 Arabic' },
            { code: 'tr', label: '🇹🇷 Turkish' },
            { code: 'nl', label: '🇳🇱 Dutch' },
            { code: 'sv', label: '🇸🇪 Swedish' },
            { code: 'no', label: '🇳🇴 Norwegian' },
            { code: 'da', label: '🇩🇰 Danish' },
            { code: 'fi', label: '🇫🇮 Finnish' },
            { code: 'pl', label: '🇵🇱 Polish' },
            { code: 'cs', label: '🇨🇿 Czech' },
            { code: 'hu', label: '🇭🇺 Hungarian' },
            { code: 'ro', label: '🇷🇴 Romanian' },
            { code: 'el', label: '🇬🇷 Greek' },
            { code: 'he', label: '🇮🇱 Hebrew' },
            { code: 'th', label: '🇹🇭 Thai' },
            { code: 'ta', label: '🇮🇳 Tamil' },
            { code: 'ml', label: '🇮🇳 Malayalam' },
            { code: 'te', label: '🇮🇳 Telugu' },
            { code: 'kn', label: '🇮🇳 Kannada' },
            { code: 'es-419', label: '🇲🇽 Latino' }
        ];
        
        // Create stars
        function createStars() {
            const container = document.getElementById('starsContainer');
            const starCount = 50;
            
            for (let i = 0; i < starCount; i++) {
                const star = document.createElement('div');
                star.className = 'star';
                star.style.left = Math.random() * 100 + '%';
                star.style.top = Math.random() * 100 + '%';
                star.style.width = (Math.random() * 2 + 1) + 'px';
                star.style.height = star.style.width;
                star.style.animationDelay = Math.random() * 3 + 's';
                container.appendChild(star);
            }
        }
        
        // Initialize loading sequence
        setTimeout(() => {
            document.getElementById('loadingScreen').classList.add('hidden');
            document.getElementById('mainContent').classList.remove('hidden');
            document.getElementById('step0').classList.add('card-in');
            updateStepIndicators();
        }, 2000);
        
        function nextStep() {
            if (currentStep === 2 && !validateServices()) {
                document.getElementById('validationModal').classList.remove('hidden');
                return;
            }
            
            const currentStepEl = document.getElementById(\`step\${currentStep}\`);
            currentStepEl.classList.add('hidden');
            
            currentStep++;
            
            const nextStepEl = document.getElementById(\`step\${currentStep}\`);
            nextStepEl.classList.remove('hidden');
            nextStepEl.classList.add('slide-down');
            
            if (currentStep > 0) {
                document.getElementById('stepIndicators').classList.remove('hidden');
            }
            
            updateStepIndicators();
            updateLink();
        }
        
        function prevStep() {
            // Don't allow going back to welcome screen
            if (currentStep <= 1) return;
            
            const currentStepEl = document.getElementById(\`step\${currentStep}\`);
            currentStepEl.classList.add('hidden');
            
            currentStep--;
            
            const prevStepEl = document.getElementById(\`step\${currentStep}\`);
            prevStepEl.classList.remove('hidden');
            prevStepEl.classList.add('slide-down');
            
            updateStepIndicators();
        }
        
        function updateStepIndicators() {
            const indicators = document.querySelectorAll('.step-indicator');
            indicators.forEach((indicator, index) => {
                indicator.classList.remove('active', 'completed');
                if (index === currentStep) {
                    indicator.classList.add('active');
                } else if (index < currentStep) {
                    indicator.classList.add('completed');
                }
            });
        }
        
        function selectConfigStyle(style) {
            configStyle = style;
            const cards = document.querySelectorAll('.config-style-card');
            cards.forEach(card => {
                card.classList.remove('border-[#4ac4b1]');
                card.classList.add('border-gray-700');
            });
            event.currentTarget.classList.remove('border-gray-700');
            event.currentTarget.classList.add('border-[#4ac4b1]');
        }
        
        function addService(provider = 'RealDebrid', apiKey = '', extraConfig = {}) {
            const container = document.getElementById('servicesContainer');
            const index = serviceIndex++;
            
            const serviceRow = document.createElement('div');
            serviceRow.className = 'service-row bg-[#1f2937] rounded-lg border border-gray-700';
            serviceRow.dataset.index = index;
            
            serviceRow.innerHTML = \`
                <div class="service-header flex flex-col sm:flex-row gap-3 p-4">
                    <label for="provider-\${index}" class="sr-only">Debrid Provider</label>
                    <select id="provider-\${index}" class="debrid-provider flex-1 bg-[#111827] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm" onclick="event.stopPropagation()" aria-label="Select debrid service provider">
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
                    <div class="flex-1 flex gap-2">
                        <div class="flex-1 relative">
                            <label for="apikey-\${index}" class="sr-only">API Key</label>
                            <input type="password" id="apikey-\${index}" placeholder="Enter API key" class="debrid-apikey w-full bg-[#111827] border border-gray-600 rounded-lg px-4 py-2.5 pr-10 text-white text-sm" onclick="event.stopPropagation()" aria-label="Enter API key for selected service">
                            <button type="button" class="toggle-password absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#4ac4b1] transition-colors p-1" onclick="event.stopPropagation()" aria-label="Toggle password visibility">
                                <svg class="w-5 h-5 eye-open" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                                </svg>
                                <svg class="w-5 h-5 eye-closed hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path>
                                </svg>
                            </button>
                        </div>
                        <a href="#" class="get-key-link text-[#4ac4b1] hover:text-[#4fd4c1] text-sm self-center whitespace-nowrap" target="_blank" onclick="event.stopPropagation()">Get key</a>
                    </div>
                    <div class="flex gap-2">
                        <button type="button" class="toggle-config hidden px-3 py-2.5 bg-[#374151] hover:bg-[#4b5563] text-white text-sm rounded-lg transition-colors">
                            <svg class="w-4 h-4 transform transition-transform chevron-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                            </svg>
                        </button>
                        <button type="button" class="remove-service border border-red-500 text-red-500 hover:bg-red-500 hover:text-white transition-all rounded-lg px-4 py-2.5 text-sm font-medium" onclick="event.stopPropagation()">
                        Remove
                    </button>
                </div>
                </div>
                <div class="service-config-wrapper hidden border-t border-gray-700">
                    <div class="service-config p-4"></div>
                </div>
            \`;
            
            container.appendChild(serviceRow);
            
            const select = serviceRow.querySelector('.debrid-provider');
            const input = serviceRow.querySelector('.debrid-apikey');
            const configDiv = serviceRow.querySelector('.service-config');
            const configWrapper = serviceRow.querySelector('.service-config-wrapper');
            const removeBtn = serviceRow.querySelector('.remove-service');
            const toggleBtn = serviceRow.querySelector('.toggle-config');
            const chevronIcon = serviceRow.querySelector('.chevron-icon');
            const getKeyLink = serviceRow.querySelector('.get-key-link');
            
            select.value = provider;
            input.value = apiKey;
            
            const passwordToggle = serviceRow.querySelector('.toggle-password');
            passwordToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const type = input.type === 'password' ? 'text' : 'password';
                input.type = type;
                serviceRow.querySelector('.eye-open').classList.toggle('hidden');
                serviceRow.querySelector('.eye-closed').classList.toggle('hidden');
            });
            
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                configWrapper.classList.toggle('hidden');
                chevronIcon.classList.toggle('rotate-180');
            });
            
            // Update get key link based on provider
            function updateGetKeyLink() {
                const keyUrls = {
                    'RealDebrid': 'https://real-debrid.com/apitoken',
                    'TorBox': 'https://torbox.app/settings',
                    'AllDebrid': 'https://alldebrid.com/apikeys',
                    'Premiumize': 'https://www.premiumize.me/account',
                    'OffCloud': 'https://offcloud.com/#/account',
                    'DebriderApp': 'https://debrider.app/dashboard/account'
                };
                getKeyLink.href = keyUrls[select.value] || '#';
                getKeyLink.style.display = keyUrls[select.value] ? 'inline' : 'none';
            }
            
            updateGetKeyLink();
            
            // Handle provider-specific fields
            function updateProviderFields() {
                configDiv.innerHTML = '';
                updateGetKeyLink();
                
                const hasExtraConfig = ['Usenet', 'HomeMedia', 'httpstreaming'].includes(select.value);
                toggleBtn.classList.toggle('hidden', !hasExtraConfig);
                
                if (!hasExtraConfig) {
                    configWrapper.classList.add('hidden');
                    chevronIcon.classList.remove('rotate-180');
                }
                
                if (select.value === 'Usenet') {
                    input.placeholder = 'Newznab API Key';
                    configDiv.innerHTML = \`
                        <input type="text" placeholder="Newznab URL (e.g., https://api.nzbgeek.info)" class="newznab-url w-full bg-[#111827] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.newznabUrl || ''}">
                        <input type="text" placeholder="SABnzbd URL (e.g., localhost:8080)" class="sabnzbd-url w-full bg-[#111827] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.sabnzbdUrl || ''}">
                        <input type="text" placeholder="SABnzbd API Key" class="sabnzbd-apikey w-full bg-[#111827] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.sabnzbdApiKey || ''}">
                        <input type="text" placeholder="File Server URL (Required - e.g., http://localhost:8081)" class="file-server-url w-full bg-[#111827] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.fileServerUrl || ''}">
                        <input type="text" placeholder="File Server Password (Optional)" class="file-server-password w-full bg-[#111827] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.fileServerPassword || ''}">
                        <p class="text-gray-400 text-xs mt-2 mb-3">Required: File server for direct streaming - <a href="https://github.com/sooti/stremio-addon-debrid-search/tree/main/media-file-server" target="_blank" class="text-[#4ac4b1] hover:underline">Setup Guide</a></p>
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-3 mt-3">
                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <div class="text-[#4ac4b1] font-semibold text-xs mb-2">Cleanup Options</div>
                                    <label class="flex items-center space-x-1.5 mb-1.5 cursor-pointer">
                                        <input type="checkbox" class="usenet-delete-on-stop checkbox-custom" \${extraConfig.deleteOnStreamStop ? 'checked' : ''}>
                                        <span class="text-white text-xs">Delete on stream stop</span>
                                    </label>
                                    <label class="flex items-center space-x-1.5 cursor-pointer">
                                        <input type="checkbox" class="usenet-auto-clean checkbox-custom" \${extraConfig.autoCleanOldFiles ? 'checked' : ''}>
                                        <span class="text-white text-xs">Auto-clean</span>
                                        <input type="number" class="usenet-clean-age bg-[#111827] border border-gray-600 rounded px-1.5 py-0.5 text-white text-xs w-12 ml-1" min="1" max="365" value="\${extraConfig.autoCleanAgeDays || 7}">
                                        <span class="text-gray-400 text-xs">days</span>
                                    </label>
                                </div>
                                <div>
                                    <div class="text-[#4ac4b1] font-semibold text-xs mb-2">HTTP Sources</div>
                                    <label class="flex items-center space-x-1.5 mb-1.5 cursor-pointer">
                                        <input type="checkbox" class="usenet-http-4khdhub checkbox-custom" \${extraConfig.http4khdhub !== false ? 'checked' : ''}>
                                        <span class="text-white text-xs">4KHDHub</span>
                                    </label>
                                    <label class="flex items-center space-x-1.5 cursor-pointer">
                                        <input type="checkbox" class="usenet-http-uhdmovies checkbox-custom" \${extraConfig.httpUHDMovies !== false ? 'checked' : ''}>
                                        <span class="text-white text-xs">UHDMovies</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    \`;
                } else if (select.value === 'HomeMedia') {
                    input.placeholder = 'Home Media API Key (Optional)';
                    input.style.display = '';
                    configDiv.innerHTML = \`
                        <input type="text" placeholder="Home Media Server URL (e.g., http://localhost:3003)" class="homemedia-url w-full bg-[#111827] border border-gray-600 rounded-lg px-4 py-2.5 text-white text-sm mb-2" value="\${extraConfig.homeMediaUrl || ''}">
                        <p class="text-gray-400 text-xs mb-2">URL to your personal media file server - <a href="https://github.com/sooti/stremio-addon-debrid-search/tree/main/media-file-server" target="_blank" class="text-[#4ac4b1] hover:underline">Setup Guide</a></p>
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-3 mt-3">
                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <div class="text-[#4ac4b1] font-semibold text-xs mb-2">Cleanup Options</div>
                                    <label class="flex items-center space-x-1.5 mb-1.5 cursor-pointer">
                                        <input type="checkbox" class="homemedia-delete-on-stop checkbox-custom" \${extraConfig.deleteOnStreamStop ? 'checked' : ''}>
                                        <span class="text-white text-xs">Delete on stream stop</span>
                                    </label>
                                    <label class="flex items-center space-x-1.5 cursor-pointer">
                                        <input type="checkbox" class="homemedia-auto-clean checkbox-custom" \${extraConfig.autoCleanOldFiles ? 'checked' : ''}>
                                        <span class="text-white text-xs">Auto-clean</span>
                                        <input type="number" class="homemedia-clean-age bg-[#111827] border border-gray-600 rounded px-1.5 py-0.5 text-white text-xs w-12 ml-1" min="1" max="365" value="\${extraConfig.autoCleanAgeDays || 7}">
                                        <span class="text-gray-400 text-xs">days</span>
                                    </label>
                                </div>
                                <div>
                                    <div class="text-[#4ac4b1] font-semibold text-xs mb-2">HTTP Sources</div>
                                    <label class="flex items-center space-x-1.5 mb-1.5 cursor-pointer">
                                        <input type="checkbox" class="homemedia-http-4khdhub checkbox-custom" \${extraConfig.http4khdhub !== false ? 'checked' : ''}>
                                        <span class="text-white text-xs">4KHDHub</span>
                                    </label>
                                    <label class="flex items-center space-x-1.5 cursor-pointer">
                                        <input type="checkbox" class="homemedia-http-uhdmovies checkbox-custom" \${extraConfig.httpUHDMovies !== false ? 'checked' : ''}>
                                        <span class="text-white text-xs">UHDMovies</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    \`;
                } else if (select.value === 'httpstreaming') {
                    input.style.display = 'none';
                    configDiv.innerHTML = \`
                        <div class="bg-[#0f1729] border border-[#2a3547] rounded-lg p-4">
                            <div class="text-[#4ac4b1] font-semibold text-sm mb-3">HTTP Streaming Sources</div>
                            <label class="flex items-center space-x-2 mb-2 cursor-pointer">
                                <input type="checkbox" class="http-4khdhub checkbox-custom" \${extraConfig.http4khdhub !== false ? 'checked' : ''}>
                                <span class="text-white text-sm">4KHDHub</span>
                            </label>
                            <label class="flex items-center space-x-2 cursor-pointer">
                                <input type="checkbox" class="http-uhdmovies checkbox-custom" \${extraConfig.httpUHDMovies !== false ? 'checked' : ''}>
                                <span class="text-white text-sm">UHDMovies</span>
                            </label>
                        </div>
                    \`;
                } else {
                    input.style.display = '';
                    input.placeholder = 'Enter API key';
                }
                
                configDiv.querySelectorAll('input').forEach(inp => {
                    inp.addEventListener('input', updateLink);
                    inp.addEventListener('change', updateLink);
                });
                
                updateLink();
            }
            
            select.addEventListener('change', () => {
                updateProviderFields();
                if (['Usenet', 'HomeMedia', 'httpstreaming'].includes(select.value)) {
                    configWrapper.classList.remove('hidden');
                    chevronIcon.classList.add('rotate-180');
                }
            });
            input.addEventListener('input', updateLink);
            removeBtn.addEventListener('click', () => {
                serviceRow.remove();
                updateLink();
            });
            
            updateProviderFields();
            
            if (['Usenet', 'HomeMedia', 'httpstreaming'].includes(provider)) {
                configWrapper.classList.remove('hidden');
                chevronIcon.classList.add('rotate-180');
            }
        }
        
        function initLanguages() {
            const container = document.getElementById('languagesContainer');
            languages.forEach(lang => {
                const checked = existingLanguages.includes(lang.code) ? 'checked' : '';
                const label = document.createElement('label');
                label.className = 'flex items-center space-x-2 p-2 hover:bg-[#111827] rounded cursor-pointer';
                label.innerHTML = \`
                    <input type="checkbox" value="\${lang.code}" class="checkbox-custom" \${checked}>
                    <span class="text-white text-sm">\${lang.label}</span>
                \`;
                label.querySelector('input').addEventListener('change', updateLink);
                container.appendChild(label);
            });
        }
        
        function getDebridServices() {
            const services = [];
            const rows = document.querySelectorAll('#servicesContainer [data-index]');
            rows.forEach(row => {
                const provider = row.querySelector('.debrid-provider').value;
                const apiKey = row.querySelector('.debrid-apikey').value;
                
                const service = { provider, apiKey };
                
                if (provider === 'Usenet') {
                    service.newznabUrl = row.querySelector('.newznab-url')?.value || '';
                    service.sabnzbdUrl = row.querySelector('.sabnzbd-url')?.value || '';
                    service.sabnzbdApiKey = row.querySelector('.sabnzbd-apikey')?.value || '';
                    service.fileServerUrl = row.querySelector('.file-server-url')?.value || '';
                    service.fileServerPassword = row.querySelector('.file-server-password')?.value || '';
                    service.deleteOnStreamStop = row.querySelector('.usenet-delete-on-stop')?.checked || false;
                    service.autoCleanOldFiles = row.querySelector('.usenet-auto-clean')?.checked || false;
                    service.autoCleanAgeDays = parseInt(row.querySelector('.usenet-clean-age')?.value) || 7;
                    service.http4khdhub = row.querySelector('.usenet-http-4khdhub')?.checked ?? true;
                    service.httpUHDMovies = row.querySelector('.usenet-http-uhdmovies')?.checked ?? true;
                } else if (provider === 'HomeMedia') {
                    service.homeMediaUrl = row.querySelector('.homemedia-url')?.value || '';
                    service.deleteOnStreamStop = row.querySelector('.homemedia-delete-on-stop')?.checked || false;
                    service.autoCleanOldFiles = row.querySelector('.homemedia-auto-clean')?.checked || false;
                    service.autoCleanAgeDays = parseInt(row.querySelector('.homemedia-clean-age')?.value) || 7;
                    service.http4khdhub = row.querySelector('.homemedia-http-4khdhub')?.checked ?? true;
                    service.httpUHDMovies = row.querySelector('.homemedia-http-uhdmovies')?.checked ?? true;
                } else if (provider === 'httpstreaming') {
                    service.http4khdhub = row.querySelector('.http-4khdhub')?.checked ?? true;
                    service.httpUHDMovies = row.querySelector('.http-uhdmovies')?.checked ?? true;
                }
                
                services.push(service);
            });
            return services;
        }
        
        function validateServices() {
            const services = getDebridServices();
            if (services.length === 0) return false;
            
            return services.every(s => {
                if (s.provider === 'Usenet') {
                    return s.provider && s.apiKey && s.newznabUrl && s.sabnzbdUrl && s.sabnzbdApiKey && s.fileServerUrl;
                } else if (s.provider === 'HomeMedia') {
                    return s.provider && s.homeMediaUrl;
                } else if (s.provider === 'httpstreaming') {
                    return true;
                }
                return s.provider && s.apiKey;
            });
        }
        
        function getSelectedLanguages() {
            const checkboxes = document.querySelectorAll('#languagesContainer input:checked');
            return Array.from(checkboxes).map(cb => cb.value);
        }
        
        function updateLink() {
            const services = getDebridServices();
            const languages = getSelectedLanguages();
            const minSize = parseInt(document.getElementById('minSize')?.value || 0);
            const maxSize = parseInt(document.getElementById('maxSize')?.value || 200);
            
            const config = {
                DebridServices: services,
                configStyle: configStyle
            };
            
            if (languages.length > 0) {
                config.Languages = languages;
            }
            
            if (minSize > 0 || maxSize < 200) {
                config.minSize = minSize;
                config.maxSize = maxSize;
            }
            
            const configStr = JSON.stringify(config);
            const encodedConfig = encodeURIComponent(configStr);
            
            const host = window.location.host;
            window.manifestUrl = 'stremio://' + host + '/' + encodedConfig + '/manifest.json';
        }
        
        function copyManifestLink() {
            if (!window.manifestUrl || window.manifestUrl === '#' || window.manifestUrl === '' || window.manifestUrl.indexOf('stremio://') === -1) {
                alert('Please complete the configuration first');
                return;
            }
            
            const manifestUrl = window.manifestUrl.replace('stremio://', 'https://');
            
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(manifestUrl).then(() => {
                    showToast();
                }).catch(() => {
                    fallbackCopy(manifestUrl);
                });
            } else {
                fallbackCopy(manifestUrl);
            }
        }
        
        function fallbackCopy(text) {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '0';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                document.execCommand('copy');
                showToast();
            } catch (err) {
                alert('Failed to copy to clipboard');
            }
            document.body.removeChild(textArea);
        }
        
        function showToast() {
            const toast = document.getElementById('toast');
            toast.style.opacity = '1';
            toast.style.pointerEvents = 'auto';
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.pointerEvents = 'none';
            }, 2000);
        }
        
        function closeValidationModal() {
            document.getElementById('validationModal').classList.add('hidden');
        }
        
        const installBtn = document.getElementById('installBtn');
        if (installBtn) {
            installBtn.addEventListener('click', function(e) {
                if (!window.manifestUrl || window.manifestUrl === '#' || window.manifestUrl.indexOf('stremio://') === -1) {
                    alert('Please complete the configuration first');
                    return;
                }
                
                const btn = e.currentTarget;
                const orig = btn.textContent;
                const baseClass = 'transition-colors text-lg font-bold rounded-lg px-16 py-4';
                
                btn.textContent = 'Sending to Stremio...';
                btn.className = baseClass + ' bg-gray-600 text-white pointer-events-none';
                
                window.location.href = window.manifestUrl;
                
                setTimeout(() => btn.textContent = 'Sent!', 800);
                setTimeout(() => { 
                    btn.textContent = orig;
                    btn.className = baseClass + ' bg-[#4ac4b1] hover:bg-[#4fd4c1] text-[#0a0a0a] cursor-pointer';
                }, 2200);
            });
        }
        
        createStars();
        
        document.addEventListener('click', function(e) {
            const tooltip = e.target.closest('.tooltip');
            if (tooltip) {
                e.preventDefault();
                e.stopPropagation();
                const isShown = tooltip.classList.contains('tooltip-show');
                document.querySelectorAll('.tooltip').forEach(t => t.classList.remove('tooltip-show'));
                if (!isShown) {
                    tooltip.classList.add('tooltip-show');
                }
            } else {
                document.querySelectorAll('.tooltip').forEach(t => t.classList.remove('tooltip-show'));
            }
        });
        
        let scrollY = 0;
        document.addEventListener('focus', function(e) {
            if (e.target.matches('input, select, textarea')) {
                scrollY = window.scrollY;
            }
        }, true);
        
        document.addEventListener('blur', function(e) {
            if (e.target.matches('input, select, textarea')) {
                setTimeout(() => {
                    const currentStep = document.querySelector('.step-content:not(.hidden)');
                    if (currentStep) {
                        window.scrollTo(0, 0);
                        currentStep.scrollIntoView({ behavior: 'instant', block: 'start' });
                    }
                }, 150);
            }
        }, true);
        
        setTimeout(() => {
            const cards = document.querySelectorAll('.config-style-card');
            cards.forEach(card => card.classList.replace('border-[#4ac4b1]', 'border-gray-700'));
            cards[configStyle === 'advanced' ? 1 : 0]?.classList.replace('border-gray-700', 'border-[#4ac4b1]');
            
            existingServices.forEach(s => addService(s.provider, s.apiKey, s));
            if (existingServices.length === 0) addService();
        }, 50);
        
        // Initialize languages
        initLanguages();
        
        // Initialize file size sliders
        document.getElementById('minSize').value = existingMinSize;
        document.getElementById('maxSize').value = existingMaxSize;
        document.getElementById('minSizeValue').textContent = existingMinSize;
        document.getElementById('maxSizeValue').textContent = existingMaxSize;
        
        document.getElementById('minSize').addEventListener('input', function() {
            let minVal = parseInt(this.value);
            let maxVal = parseInt(document.getElementById('maxSize').value);
            if (minVal > maxVal) {
                this.value = maxVal;
                minVal = maxVal;
            }
            document.getElementById('minSizeValue').textContent = minVal;
            updateLink();
        });
        
        document.getElementById('maxSize').addEventListener('input', function() {
            let minVal = parseInt(document.getElementById('minSize').value);
            let maxVal = parseInt(this.value);
            if (maxVal < minVal) {
                this.value = minVal;
                maxVal = minVal;
            }
            document.getElementById('maxSizeValue').textContent = maxVal;
            updateLink();
        });
        
        updateLink();
    </script>
</body>
</html>
    `;
}

export default landingTemplateNew;

