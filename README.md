# Katulong MCP Host

🤖 **Katulong** is a universal MCP (Model Context Protocol) host that runs in the background, similar to how Ollama provides easy access to local language models. It serves as a centralized host for MCP clients, allowing desktop and mobile applications to easily connect and use MCP tools and resources.

## Features

- **Background Service**: Runs quietly in the background as a system service
- **WebSocket Server**: Provides MCP protocol support via WebSocket on `ws://127.0.0.1:8888`
- **Universal Host**: Allows multiple applications to connect and share MCP tools/resources
- **Cross-Platform**: Built with Tauri for Windows, macOS, and Linux support
- **Simple UI**: Basic management interface for monitoring server status

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) (v16 or later)
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)

### Development

1. Clone and navigate to the project:
   ```bash
   cd katulong
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run in development mode:
   ```bash
   npm run tauri:dev
   ```

### Building

Build for production:
```bash
npm run tauri:build
```

## MCP Protocol Support

Katulong implements the MCP 2024-11-05 specification and supports:

- **Tools**: Dynamic tool registration and execution
- **Resources**: Resource management and access
- **Client Management**: Multiple concurrent client connections

### Connecting to Katulong

Applications can connect to Katulong using the WebSocket URL:
```
ws://127.0.0.1:8888
```

### Example MCP Client Connection

```javascript
const ws = new WebSocket('ws://127.0.0.1:8888');

// Initialize connection
ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: {
        name: "my-app",
        version: "1.0.0"
      }
    }
  }));
};

// Handle responses
ws.onmessage = (event) => {
  const response = JSON.parse(event.data);
  console.log('MCP Response:', response);
};
```

## API Commands

The Tauri app exposes the following commands:

- `get_server_status()`: Returns the current server status
- `register_tool(tool_name, tool_definition)`: Register a new tool
- `register_resource(resource_name, resource_definition)`: Register a new resource

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   MCP Client    │    │  Katulong Host   │    │   MCP Client    │
│   Application   │◄──►│  (WebSocket      │◄──►│   Application   │
│                 │    │   Server)        │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │  Tools &         │
                       │  Resources       │
                       │  Registry        │
                       └──────────────────┘
```

## Use Cases

- **AI Development**: Central hub for AI tools and model access
- **Automation**: Share automation tools across multiple applications
- **Development Tools**: Centralized access to development utilities
- **Enterprise Integration**: Single point of access for company tools and resources

## Configuration

The MCP server runs on `127.0.0.1:8888` by default. This can be modified in `src-tauri/src/lib.rs`:

```rust
mcp_host_clone.start_server("127.0.0.1:8888").await
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Roadmap

- [ ] System tray integration
- [ ] Auto-start on system boot
- [ ] Configuration file support
- [ ] Plugin system for extending functionality
- [ ] Authentication and security features
- [ ] Web-based management interface
- [ ] Tool marketplace integration

---

**Katulong** (pronounced "ka-tu-long") means "helper" in Filipino, reflecting its role as a helpful assistant for MCP protocol interactions.