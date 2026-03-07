const fs = require('fs');

async function runTests() {
  const baseUrl = 'http://localhost:3001/api';
  console.log('--- Starting Backend Tests ---\n');

  try {
    // 1. Test Health Check
    console.log('1. Testing Health Check (/health)...');
    const healthRes = await fetch('http://localhost:3001/health');
    const healthData = await healthRes.json();
    console.log('Response:', healthData, '\n');

    // 2. Test Conversation Creation
    console.log('2. Testing Conversation Creation (/api/conversations)...');
    const convRes = await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    
    // We expect this to fail if the User hasn't created the 'conversations' table in Supabase yet.
    let conversationId;
    if (!convRes.ok) {
        const err = await convRes.json();
        console.warn(`[Expected Warning if table missing] Failed to create conversation:`, err);
    } else {
        const convData = await convRes.json();
        console.log('Response:', convData);
        conversationId = convData.id;
        console.log(`Created Conversation ID: ${conversationId}\n`);
    }

    // 3. Test Message Creation
    console.log('\n3. Testing Message Check (/api/messages)...');
    // Using the real conversation ID
    const messageRes = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversationId,
        author: 'agent', 
        content: 'This is a test message from the automated script.',
        start: new Date().toISOString(),
        end: new Date(Date.now() + 5000).toISOString()
      })
    });
    
    if (!messageRes.ok) {
        const err = await messageRes.json();
        console.warn(`[Expected Warning if table missing] Failed to create message:`, err);
    } else {
        const msgData = await messageRes.json();
        console.log('Response:', msgData);
        console.log(`Created Message ID: ${msgData.id}\n`);
    }

  } catch (error) {
    console.error('Test Failed:', error.message);
  }
}

runTests();
