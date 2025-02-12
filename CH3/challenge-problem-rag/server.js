const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

const openai = require('./openai');
const { ChromaClient, OpenAIEmbeddingFunction } = require('chromadb');


app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'feedback_admin.html'));
});

//const systemPrompt = "You are a helpful chatbot who wil analyze information that is sent to you in prompts with Context, and will reason across that data to give intelligent answers."
//const systemPrompt = "You are an expert in public speaking, and you know how to create engaging and powerful talks. You understand how to structure them, and put them in simple language. Help me create a new talk by starting a conversation with me about what the talk will be about.";
const systemPrompt = "You are a librarian who knows much about books and characters. You know many details about the characters, events, and storylines in whatever book may be asked of. You can form reasonable opinions when asked opionated questions. You can hold a conversation with the user and use logic and reason to make an argument or point.";

function generateUserId() {
  return crypto.randomBytes(16).toString('hex');
}

async function logConversation(userId, conversation) {
  const logDir = path.join(__dirname, 'logs');
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${userId}.json`);
  await fs.writeFile(logFile, JSON.stringify(conversation, null, 2));
}

async function logFeedback(userId, messageId, feedback, message) {
  const logDir = path.join(__dirname, 'feedback_logs');
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${userId}_feedback.json`);
  const feedbackEntry = { messageId, feedback, message, timestamp: new Date().toISOString() };
  
  let feedbackLog = [];
  try {
    const existingLog = await fs.readFile(logFile, 'utf8');
    feedbackLog = JSON.parse(existingLog);
  } catch (error) {
    // File doesn't exist yet, which is fine
  }
  feedbackLog.push(feedbackEntry);
  await fs.writeFile(logFile, JSON.stringify(feedbackLog, null, 2));
}

async function queryChromaDB(message){
  const embedder = new OpenAIEmbeddingFunction({
      openai_api_key: openai.openai_api_key,
      model_name: "text-embedding-ada-002"
    });
    const client = new ChromaClient({
      path: "http://127.0.0.1:8000"
    });
    const collection = await client.getCollection({
      name: 'pdf_embeddings',
      embeddingFunction: embedder
    });
    const queryEmbedding = await embedder.generate([message]);
    let resultString = '';
    const results = await collection.query({
      queryEmbeddings: queryEmbedding,
      nResults: 5
    });

    if (results.documents && results.documents[0]) {
      results.documents[0].forEach((doc, index) => {
        resultString += `\n${index + 1}. ${doc}\n`;
      });
    } else {
      resultString += "\n";
    }
    return resultString
}

io.on('connection', (socket) => {
  console.log('New client connected');

  const userId = generateUserId();
  console.log(`Assigned user ID: ${userId}`);

  socket.emit('chat response', { 
    messageId: crypto.randomBytes(16).toString('hex'),
    content: "Hello! I'm here to help answer your questions for the book The Hunger Games. Feel free to ask me any objective or subjective questions you may have for this book.",
    isInitialMessage: true
  });

  let conversationHistory = [
    { role: "system", content: systemPrompt }
  ];

  logConversation(userId, conversationHistory);

  async function generateResponse() {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: conversationHistory,
    });

    const response = completion.choices[0].message.content;
    const messageId = crypto.randomBytes(16).toString('hex');
    
    conversationHistory.push({ role: "assistant", content: response, messageId });
    await logConversation(userId, conversationHistory);

    return { messageId, content: response };
  }

  socket.on('chat message', async (message) => {
    try {
      socket.emit('Retrieving RAG', true)
      let ragString = "Context:\n"
      ragString += await queryChromaDB(message)
      ragString += "\n"
      ragString += "Message:\n"
      ragString += message
      ragString += "\n"

      socket.emit('thinking', true);

      conversationHistory.push({ role: "user", content: ragString });
      await logConversation(userId, conversationHistory);

      const response = await generateResponse();

      socket.emit('thinking', false);
      socket.emit('chat response', response);
    } catch (error) {
      console.error('Error:', error);
      socket.emit('thinking', false);
      socket.emit('chat response', { 
        messageId: crypto.randomBytes(16).toString('hex'),
        content: 'Sorry, there was an error processing your request.'
      });
    }
  });

  socket.on('feedback', async (data) => {
    const { messageId, feedback } = data;
    const message = conversationHistory.find(entry => entry.messageId === messageId)?.content || '';
    logFeedback(userId, messageId, feedback, message);
    console.log(`Feedback received for message ${messageId}: ${feedback}`);

    if (feedback === 'bad') {
      try {
        socket.emit('thinking', true);
        // Remove the last assistant message from conversation history
        conversationHistory.pop();
        const newResponse = await generateResponse();
        socket.emit('thinking', false);
        socket.emit('regenerate response', {
          oldMessageId: messageId,
          newResponse: {
            messageId: newResponse.messageId,
            content: "Trying again... " + newResponse.content
          }
        });
      } catch (error) {
        console.error('Error regenerating response:', error);
        socket.emit('thinking', false);
        socket.emit('chat response', { 
          messageId: crypto.randomBytes(16).toString('hex'),
          content: 'Sorry, there was an error regenerating the response.'
        });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${userId}`);
    logConversation(userId, conversationHistory);
  });
});

// Admin routes
app.get('/admin/feedback-summary', async (req, res) => {
  const logDir = path.join(__dirname, 'feedback_logs');
  const files = await fs.readdir(logDir);
  let good = 0, neutral = 0, bad = 0;

  for (const file of files) {
    const content = await fs.readFile(path.join(logDir, file), 'utf8');
    const feedbackLog = JSON.parse(content);
    feedbackLog.forEach(entry => {
      if (entry.feedback === 'good') good++;
      else if (entry.feedback === 'neutral') neutral++;
      else if (entry.feedback === 'bad') bad++;
    });
  }

  res.json({ good, neutral, bad, totalFiles: files.length });
});

app.get('/admin/feedback-files', async (req, res) => {
  const logDir = path.join(__dirname, 'feedback_logs');
  const files = await fs.readdir(logDir);
  res.json(files);
});

app.get('/admin/feedback-file/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'feedback_logs', filename);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    res.json(JSON.parse(content));
  } catch (error) {
    console.error('Error reading feedback file:', error);
    res.status(500).json({ error: 'Error reading feedback file' });
  }
});

app.post('/admin/feedback-file/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'feedback_logs', filename);
  const content = req.body.content;

  try {
    await fs.writeFile(filePath, JSON.stringify(JSON.parse(content), null, 2));
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving file:', error);
    res.status(500).json({ success: false, error: 'Error saving file' });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});