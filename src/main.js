// Check if Tauri is available, if not provide fallback
let invoke;
try {
    invoke = window.__TAURI__?.core?.invoke;
    console.log('Tauri API available:', !!invoke);
} catch (error) {
    console.log('Tauri API not available, using fallback');
    invoke = () => Promise.resolve({});
}

// Global state
let services = [];
let availableServices = [];

// Initialize app
function initializeApp() {
    console.log('Katulong MCP Host initializing...');
    console.log('DOM loaded, checking elements...');
    console.log('servicesGrid element:', document.getElementById('servicesGrid'));
    console.log('serviceDropdown element:', document.getElementById('serviceDropdown'));
    
    loadSampleServices();
    renderServices();
    loadAvailableServices();
    setupEventListeners();
}

// Try multiple initialization strategies
document.addEventListener('DOMContentLoaded', initializeApp);

// Fallback for Tauri
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    // DOM already loaded
    setTimeout(initializeApp, 100);
}

function loadSampleServices() {
    services = [
        {
            id: '1',
            name: 'OpenAI',
            type: 'openai',
            icon: '🤖',
            status: 'connected',
            description: 'GPT-4 and API access'
        },
        {
            id: '2', 
            name: 'GitHub',
            type: 'github',
            icon: '🐙',
            status: 'connected',
            description: 'Repository management'
        },
        {
            id: '3',
            name: 'Slack',
            type: 'slack', 
            icon: '💬',
            status: 'disconnected',
            description: 'Team communication'
        }
    ];
}

function renderServices() {
    console.log('renderServices called, services:', services);
    const grid = document.getElementById('servicesGrid');
    
    if (!grid) {
        console.error('servicesGrid element not found');
        return;
    }
    
    const servicesHTML = services.map(service => `
        <div class="service-tile ${service.status}" onclick="configureService('${service.id}')">
            <div class="status-dot ${service.status}"></div>
            <div class="service-icon">${service.icon}</div>
            <div class="service-name">${service.name}</div>
            <div class="service-status ${service.status}">${service.description}</div>
        </div>
    `).join('');
    
    const addServiceTile = `
        <div class="service-tile add-service" onclick="addService()">
            <div class="service-icon">+</div>
            <div class="service-name">Add Service</div>
            <div class="service-status">Connect a new MCP service</div>
        </div>
    `;
    
    const finalHTML = servicesHTML + addServiceTile;
    console.log('Setting grid innerHTML:', finalHTML);
    grid.innerHTML = finalHTML;
}

function setupEventListeners() {
    // Service dropdown functionality
    const serviceDropdown = document.getElementById('serviceDropdown');
    if (serviceDropdown) {
        serviceDropdown.addEventListener('change', (e) => {
            if (e.target.value) {
                addServiceFromCatalog(e.target.value);
                e.target.value = ''; // Reset dropdown
            }
        });
    }
    
    // Form submission
    const form = document.getElementById('addServiceForm');
    if (form) {
        form.addEventListener('submit', handleServiceSubmit);
    }
}

async function loadAvailableServices() {
    try {
        const response = await fetch('./mcp_servers_catalog.json');
        const catalog = await response.json();
        
        // Flatten all services from all categories
        availableServices = [];
        Object.keys(catalog.categories).forEach(category => {
            catalog.categories[category].forEach(service => {
                availableServices.push({
                    ...service,
                    category,
                    value: service.name.toLowerCase().replace(/\s+/g, '_')
                });
            });
        });
        
        populateServiceDropdown();
    } catch (error) {
        console.error('Failed to load service catalog:', error);
        // Fallback to basic services
        availableServices = [
            { name: 'GitHub', icon: '🐙', value: 'github', category: 'Development' },
            { name: 'Slack', icon: '💬', value: 'slack', category: 'Productivity' },
            { name: 'OpenAI', icon: '🤖', value: 'openai', category: 'AI & Memory' },
            { name: 'File System', icon: '📁', value: 'filesystem', category: 'File & Storage' },
            { name: 'PostgreSQL', icon: '🐘', value: 'postgres', category: 'Database' },
        ];
        populateServiceDropdown();
    }
}

function populateServiceDropdown() {
    const dropdown = document.getElementById('serviceDropdown');
    if (!dropdown) return;
    
    // Clear existing options except the first one
    dropdown.innerHTML = '<option value="">Browse all services...</option>';
    
    // Group services by category
    const servicesByCategory = {};
    availableServices.forEach(service => {
        if (!servicesByCategory[service.category]) {
            servicesByCategory[service.category] = [];
        }
        servicesByCategory[service.category].push(service);
    });
    
    // Add options grouped by category
    Object.keys(servicesByCategory).forEach(category => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = category;
        
        servicesByCategory[category].forEach(service => {
            const option = document.createElement('option');
            option.value = service.value;
            option.textContent = `${service.icon} ${service.name}`;
            optgroup.appendChild(option);
        });
        
        dropdown.appendChild(optgroup);
    });
}

function addServiceFromCatalog(serviceValue) {
    const availableService = availableServices.find(s => s.value === serviceValue);
    if (availableService) {
        // Pre-populate the modal with the selected service
        document.getElementById('addServiceModal').style.display = 'block';
        
        // Map catalog service to our service type options
        const serviceTypeMapping = {
            'github': 'github',
            'slack': 'slack', 
            'openai': 'openai',
            'file_system': 'filesystem',
            'filesystem': 'filesystem',
            'git': 'git',
            'postgresql': 'postgres',
            'postgres': 'postgres',
            'fetch': 'fetch',
            'web_fetch': 'fetch',
            'memory': 'memory',
            'memory_store': 'memory'
        };
        
        const mappedType = serviceTypeMapping[serviceValue] || serviceValue;
        document.getElementById('serviceType').value = mappedType;
        updateServiceForm();
    }
}

function addService() {
    document.getElementById('addServiceModal').style.display = 'block';
    clearServiceForm();
}

function configureService(serviceId) {
    const service = services.find(s => s.id === serviceId);
    if (service) {
        // Open modal with existing service data
        document.getElementById('addServiceModal').style.display = 'block';
        document.getElementById('serviceType').value = service.type;
        updateServiceForm();
        // Fill existing values...
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

function clearServiceForm() {
    document.getElementById('serviceType').value = '';
    document.getElementById('serviceConfig').innerHTML = '';
}

function updateServiceForm() {
    const serviceType = document.getElementById('serviceType').value;
    const configDiv = document.getElementById('serviceConfig');
    
    const serviceConfigs = {
        'github': `
            <div class="form-group">
                <label>GitHub Token</label>
                <input type="password" id="githubToken" placeholder="ghp_..." required>
            </div>
            <div class="form-group">
                <label>Repository (optional)</label>
                <input type="text" id="githubRepo" placeholder="owner/repo">
            </div>
        `,
        'slack': `
            <div class="form-group">
                <label>Bot Token</label>
                <input type="password" id="slackToken" placeholder="xoxb-..." required>
            </div>
            <div class="form-group">
                <label>Workspace</label>
                <input type="text" id="slackWorkspace" placeholder="your-workspace">
            </div>
        `,
        'openai': `
            <div class="form-group">
                <label>API Key</label>
                <input type="password" id="openaiKey" placeholder="sk-..." required>
            </div>
            <div class="form-group">
                <label>Organization ID (optional)</label>
                <input type="text" id="openaiOrg" placeholder="org-...">
            </div>
        `,
        'filesystem': `
            <div class="form-group">
                <label>Base Directory</label>
                <input type="text" id="fsBaseDir" placeholder="/path/to/directory" required>
            </div>
            <div class="form-group">
                <label>Read-only</label>
                <input type="checkbox" id="fsReadOnly">
            </div>
        `,
        'git': `
            <div class="form-group">
                <label>Repository Path</label>
                <input type="text" id="gitRepoPath" placeholder="/path/to/repo" required>
            </div>
        `,
        'postgres': `
            <div class="form-group">
                <label>Connection String</label>
                <input type="password" id="pgConnection" placeholder="postgresql://..." required>
            </div>
        `,
        'fetch': `
            <div class="form-group">
                <label>User Agent</label>
                <input type="text" id="fetchUserAgent" placeholder="Katulong MCP Client">
            </div>
        `,
        'memory': `
            <div class="form-group">
                <label>Memory Size (MB)</label>
                <input type="number" id="memorySize" value="100" min="10" max="1000">
            </div>
        `
    };
    
    configDiv.innerHTML = serviceConfigs[serviceType] || '';
}

function handleServiceSubmit(e) {
    e.preventDefault();
    
    const serviceType = document.getElementById('serviceType').value;
    const serviceIcons = {
        'github': '🐙',
        'slack': '💬', 
        'openai': '🤖',
        'filesystem': '📁',
        'git': '🔧',
        'postgres': '🐘',
        'fetch': '🌐',
        'memory': '🧠'
    };
    
    const serviceNames = {
        'github': 'GitHub',
        'slack': 'Slack',
        'openai': 'OpenAI', 
        'filesystem': 'File System',
        'git': 'Git Repository',
        'postgres': 'PostgreSQL',
        'fetch': 'Web Fetch',
        'memory': 'Memory Store'
    };
    
    // Create new service
    const newService = {
        id: Date.now().toString(),
        name: serviceNames[serviceType],
        type: serviceType,
        icon: serviceIcons[serviceType],
        status: 'connected',
        description: 'Recently configured'
    };
    
    services.push(newService);
    renderServices();
    closeModal('addServiceModal');
    
    // Show success message
    alert(`${serviceNames[serviceType]} service configured successfully!`);
}

function showSettings() {
    alert('Settings panel would open here');
}

// Close modal when clicking outside
window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.style.display = 'none';
    }
});

// Make functions globally accessible
window.addService = addService;
window.configureService = configureService;
window.closeModal = closeModal;
window.updateServiceForm = updateServiceForm;
window.showSettings = showSettings;
window.addServiceFromCatalog = addServiceFromCatalog;

console.log('Katulong MCP Host UI initialized');