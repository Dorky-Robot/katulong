#!/usr/bin/env node

const WebSocket = require('ws');

// Test MCP client to verify the server is working
class TestMCPClient {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.requestId = 1;
    }

    connect() {
        return new Promise((resolve, reject) => {
            console.log(`🔌 Connecting to MCP server at ${this.url}...`);
            
            this.ws = new WebSocket(this.url);
            
            this.ws.on('open', () => {
                console.log('✅ Connected to MCP server');
                resolve();
            });
            
            this.ws.on('error', (error) => {
                console.error('❌ Connection failed:', error.message);
                reject(error);
            });
            
            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    console.log('📨 Received:', JSON.stringify(message, null, 2));
                } catch (error) {
                    console.error('❌ Failed to parse message:', data.toString());
                }
            });
            
            this.ws.on('close', () => {
                console.log('🔌 Connection closed');
            });
        });
    }

    sendRequest(method, params = null) {
        const request = {
            id: this.requestId++,
            method: method,
            params: params
        };
        
        console.log(`📤 Sending ${method}:`, JSON.stringify(request, null, 2));
        this.ws.send(JSON.stringify(request));
        
        // Give time for response
        return new Promise(resolve => setTimeout(resolve, 1000));
    }

    async runTests() {
        try {
            await this.connect();
            
            console.log('\n🧪 Running MCP Protocol Tests...\n');
            
            // Test 1: Initialize
            console.log('Test 1: Initialize');
            await this.sendRequest('initialize', {
                protocolVersion: "2024-11-05",
                clientInfo: {
                    name: "test-client",
                    version: "1.0.0"
                }
            });
            
            // Test 2: List tools
            console.log('\nTest 2: List Tools');
            await this.sendRequest('tools/list');
            
            // Test 3: List resources
            console.log('\nTest 3: List Resources');
            await this.sendRequest('resources/list');
            
            // Test 4: Invalid method
            console.log('\nTest 4: Invalid Method');
            await this.sendRequest('invalid/method');
            
            // Test 5: Tool call
            console.log('\nTest 5: Tool Call');
            await this.sendRequest('tools/call', {
                name: "test-tool",
                arguments: { test: "value" }
            });
            
            console.log('\n✅ All tests completed!');
            
        } catch (error) {
            console.error('❌ Test failed:', error);
        } finally {
            if (this.ws) {
                this.ws.close();
            }
        }
    }
}

// Run the tests
async function main() {
    console.log('🤖 Katulong MCP Server Test Client\n');
    
    const client = new TestMCPClient('ws://127.0.0.1:8888');
    await client.runTests();
    
    // Exit after tests
    setTimeout(() => {
        console.log('\n👋 Test client shutting down...');
        process.exit(0);
    }, 2000);
}

// Check if WebSocket module is available
try {
    require('ws');
    main();
} catch (error) {
    console.log('📦 Installing WebSocket dependency...');
    const { execSync } = require('child_process');
    try {
        execSync('npm install ws', { stdio: 'inherit' });
        console.log('✅ WebSocket installed, please run again');
    } catch (installError) {
        console.error('❌ Failed to install ws package. Please run: npm install ws');
        process.exit(1);
    }
}