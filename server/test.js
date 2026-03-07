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
    let conversationId;
    const convRes = await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        triage: 'agent',
        classification: 'uncertain'
      })
    });
    
    // We expect this to fail if the User hasn't created the 'conversations' table in Supabase yet.
    if (!convRes.ok) {
        const err = await convRes.json();
        console.warn(`[Expected Warning if table missing] Failed to create conversation:`, err);
    } else {
        const convData = await convRes.json();
        console.log('Response:', convData);
        conversationId = convData.id;
        console.log(`Created Conversation ID: ${conversationId}\n`);
        
        // Test updating the conversation triage and classification
        console.log('2a. Testing Conversation Update (/api/conversations/:id)...');
        const updateRes = await fetch(`${baseUrl}/conversations/${conversationId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            triage: 'operator',
            classification: 'urgent'
          })
        });
        const updateData = await updateRes.json();
        console.log('Updated Response:', updateData, '\n');
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

    // 4. Test Cloudflare R2 Audio Upload 
    console.log('\n4. Testing Audio Upload (/api/upload-audio)...');
    try {
      // Create a blob/file from the dummy file to simulate an audio buffer upload
      const dummyFileBuffer = fs.readFileSync('dummy.webm');
      const blob = new Blob([dummyFileBuffer], { type: 'audio/webm' });
      const formData = new FormData();
      formData.append('audio', blob, 'dummy.webm');

      const uploadRes = await fetch(`${baseUrl}/upload-audio`, {
        method: 'POST',
        body: formData,
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.json();
        console.warn(`[Expected Warning if R2 keys invalid] Failed to upload audio:`, err);
      } else {
        const uploadData = await uploadRes.json();
        console.log('Response:', uploadData);
        console.log(`Uploaded Audio URL: ${uploadData.url}\n`);
      }
    } catch (err) {
      console.log('Could not test R2 upload - make sure dummy.webm exists in the server folder.');
      console.error(err);
    }

  } catch (error) {
    console.error('Test Failed:', error.message);
  }
}

runTests();
