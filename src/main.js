/**
 * HotMic Main Process
 *
 * This file handles the main Electron process:
 * - Window management
 * - Recording and transcription
 * - Communication with renderer processes
 * - Global shortcuts
 * - Tray icon
 */

import { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, clipboard, nativeImage, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import FormData from 'form-data';
import fs from 'node:fs';
import os from 'node:os';
import Store from 'electron-store';
// Import fetch API for Node.js (available in modern Node.js)
import { fetch } from 'undici';

// Fix __dirname and __filename which aren't available in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if running on macOS
const isMac = process.platform === 'darwin';

/**
 * Application Configuration
 */
// Initialize persistent store for app settings
const store = new Store();

// Define temp directory for audio files
const tempDir = path.join(os.tmpdir(), 'hot-mic');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Default prompt for email formatting
const DEFAULT_PROMPT = 'Please format this transcript as a professional email with a greeting and sign-off. Make it concise and clear while maintaining the key information.';

/**
 * Application State
 */
let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isRecording = false;
let audioData = [];

/**
 * History Management
 */
function cleanupOldHistory() {
  const history = store.get('history', []);
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const newHistory = history.filter(item => item.timestamp > thirtyDaysAgo);
  store.set('history', newHistory);
}

function addToHistory(rawText, processedText) {
  const history = store.get('history', []);
  history.unshift({
    timestamp: Date.now(),
    rawText,
    processedText
  });
  store.set('history', history);

  // Notify renderer of history update
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history-updated');
  }

  cleanupOldHistory();
}

/**
 * Post-Processing with Groq
 */
async function postProcessTranscript(text) {
  const providerSettings = store.get('providerSettings', { apiKeys: {} });
  const apiKey = providerSettings.apiKeys?.groq || store.get('apiKey');
  
  if (!apiKey) {
    throw new Error('Groq API key not set for post-processing');
  }

  const promptSettings = store.get('promptSettings', {
    enabled: true,
    prompt: DEFAULT_PROMPT
  });

  if (!promptSettings.enabled) {
    return text;
  }

  try {
    updateTranscriptionProgress('processing', 'Post-processing with Groq...');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: promptSettings.prompt
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.7,
        max_tokens: 4096
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Groq API error: ${response.statusText}${errorData.error ? ' - ' + errorData.error.message : ''}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    updateTranscriptionProgress('error', 'Post-processing failed, using raw transcript');
    return text;
  }
}

/**
 * API and Transcription
 */
async function transcribeAudio(audioBuffer) {
  const providerSettings = store.get('providerSettings', {
    provider: 'groq',
    model: 'whisper-large-v3',
    customModel: '',
    apiKeys: {
      google: '',
      groq: store.get('apiKey') || '',
      openai: ''
    }
  });

  const provider = providerSettings.provider;
  const apiKey = providerSettings.apiKeys[provider];
  const model = providerSettings.customModel || providerSettings.model;

  if (!apiKey) {
    throw new Error(`${provider.toUpperCase()} API key not set. Please configure in settings.`);
  }

  let tempFile = null;
  try {
    updateTranscriptionProgress('start', `Starting transcription with ${provider}...`);

    let rawTranscript = '';

    if (provider === 'google') {
      // Gemini expects base64 payload
      updateTranscriptionProgress('api', 'Sending to Google Gemini API...');
      const base64Data = Buffer.from(audioBuffer).toString('base64');
      rawTranscript = await sendToGeminiAPI(apiKey, model, base64Data);
    } else {
      // Create a temporary file for Whisper backends
      tempFile = path.join(tempDir, `recording-${Date.now()}.webm`);
      fs.writeFileSync(tempFile, Buffer.from(audioBuffer));

      updateTranscriptionProgress('api', `Sending to ${provider} API...`);
      rawTranscript = await sendToWhisperAPI(provider, apiKey, model, tempFile);
    }

    if (!rawTranscript?.trim()) {
      updateTranscriptionProgress('error', 'No speech detected');
      setTimeout(() => closeOverlayWindow(), 2000);
      return;
    }

    updateTranscriptionProgress('processing', 'Post-processing transcript...');
    const processedTranscript = await postProcessTranscript(rawTranscript);

    if (processedTranscript?.trim()) {
      addToHistory(rawTranscript, processedTranscript);
      updateTranscriptionProgress('complete', 'Processing complete');
      clipboard.writeText(processedTranscript);
    } else {
      updateTranscriptionProgress('error', 'Failed to process transcript');
    }

    setTimeout(() => closeOverlayWindow(), 1500);

    return processedTranscript;
  } catch (error) {
    updateTranscriptionProgress('error', `Error: ${error.message}`);
    setTimeout(() => closeOverlayWindow(), 2000);
    throw error;
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

function updateTranscriptionProgress(step, message) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('transcription-progress', { step, message });
  }
}

async function sendToGeminiAPI(apiKey, model, base64Data) {
  const promptSettings = store.get('promptSettings', { enabled: false, prompt: '' });
  let systemPrompt = "Transcribe audio to text accurately. Do not include any introductory or concluding remarks. Output ONLY the transcribed text.";
  
  const payload = {
    contents: [{
      parts: [
        { inlineData: { mimeType: "audio/webm", data: base64Data } }
      ]
    }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 1000,
      thinkingConfig: { thinkingLevel: "MINIMAL" }
    }
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || "Google API Error");
  }

  const data = await response.json();
  const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  if (!transcript.trim()) {
    throw new Error('No speech detected in audio');
  }

  return transcript;
}

async function sendToWhisperAPI(provider, apiKey, model, audioFilePath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(audioFilePath));
  formData.append('model', model);

  const urlPath = provider === 'groq' 
    ? '/openai/v1/audio/transcriptions'
    : '/v1/audio/transcriptions';
  const hostname = provider === 'groq' ? 'api.groq.com' : 'api.openai.com';

  const response = await new Promise((resolve, reject) => {
    const formHeaders = formData.getHeaders();
    const options = {
      hostname,
      path: urlPath,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...formHeaders
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
        updateTranscriptionProgress('receiving', 'Receiving transcription...');
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, data });
        } else {
          resolve({ ok: false, statusCode: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    formData.pipe(req);
  });

  if (!response.ok) {
    let errMsg = `API error (${response.statusCode})`;
    try {
      const parsed = JSON.parse(response.data);
      if (parsed.error?.message) errMsg = parsed.error.message;
    } catch (e) {}
    throw new Error(errMsg);
  }

  const result = JSON.parse(response.data);
  const transcript = result.text?.trim();

  if (!transcript) {
    throw new Error('No speech detected in audio');
  }

  return transcript;
}

/**
 * Tray Management
 */
function createTray() {
  try {
    // Clean up existing tray if it exists
    if (tray) {
      tray.destroy();
      tray = null;
    }

    // Create native image from file
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'public', 'icons', '32x32.png'));

    // Create tray with template image
    tray = new Tray(trayIcon);

    // Check if we're showing in the dock (macOS only)
    const showingInDock = isMac ? !app.dock.isVisible() : false;

    // Create context menu
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Start/Stop Recording',
        click: toggleRecording
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
          } else {
            createMainWindow();
          }
        }
      },
      { type: 'separator' },
      ...(isMac ? [
        {
          label: 'Show in Dock',
          type: 'checkbox',
          checked: showingInDock,
          click: () => toggleDockVisibility()
        },
        { type: 'separator' },
      ] : []),
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('HotMic');
    tray.setContextMenu(contextMenu);
  } catch (error) {
    console.error('Error creating tray:', error);
  }
}

/**
 * Toggle dock visibility (macOS only)
 */
function toggleDockVisibility() {
  if (!isMac) return;
  
  if (app.dock.isVisible()) {
    app.dock.hide();
  } else {
    app.dock.show();
  }

  // Update the tray menu after toggling
  if (tray) {
    const showingInDock = !app.dock.isVisible();
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Start/Stop Recording',
        click: toggleRecording
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
          } else {
            createMainWindow();
          }
        }
      },
      { type: 'separator' },
      ...(isMac ? [
        {
          label: 'Show in Dock',
          type: 'checkbox',
          checked: showingInDock,
          click: () => toggleDockVisibility()
        },
        { type: 'separator' },
      ] : []),
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(contextMenu);
  }
}

/**
 * User Input Handling
 */
function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

/**
 * IPC Handlers
 */
function setupIPCHandlers() {
  // Receive audio data from renderer
  ipcMain.handle('audio-data', async (event, audioBuffer) => {
    try {
      const transcription = await transcribeAudio(audioBuffer);
      return { success: true, transcription };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-provider-settings', () => {
    return store.get('providerSettings', {
      provider: 'groq',
      model: 'whisper-large-v3',
      customModel: '',
      apiKeys: {
        google: '',
        groq: store.get('apiKey') || '',
        openai: ''
      }
    });
  });

  ipcMain.handle('set-provider-settings', (event, settings) => {
    store.set('providerSettings', settings);
    return true;
  });

  // API key management (legacy compatibility if needed elsewhere)
  ipcMain.handle('set-api-key', (event, key) => {
    store.set('apiKey', key);
    return true;
  });

  ipcMain.handle('get-api-key', () => {
    return store.get('apiKey') || '';
  });

  // Shortcut management
  ipcMain.handle('set-shortcut', (event, shortcut) => {
    try {
      // Unregister existing shortcut
      globalShortcut.unregisterAll();

      // Register new shortcut
      globalShortcut.register(shortcut, toggleRecording);

      // Save to store
      store.set('shortcut', shortcut);
      return true;
    } catch (error) {
      console.error('Error setting shortcut:', error);
      return false;
    }
  });

  ipcMain.handle('get-shortcut', () => {
    return store.get('shortcut') || (isMac ? 'Command+Shift+Space' : 'Control+Shift+Space');
  });

  // Prompt settings
  ipcMain.handle('get-prompt-settings', () => {
    return store.get('promptSettings', {
      enabled: true,
      prompt: DEFAULT_PROMPT
    });
  });

  ipcMain.handle('set-prompt-settings', (event, settings) => {
    store.set('promptSettings', settings);
    return true;
  });

  // History management
  ipcMain.handle('get-history', () => {
    cleanupOldHistory();
    return store.get('history', []);
  });

  // Settings window management
  ipcMain.handle('open-settings', () => {
    // Close overlay window if open and cancel any ongoing transcription
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('cancel-transcription');
      closeOverlayWindow();
    }

    // Stop recording if active
    if (isRecording) {
      isRecording = false;
      audioData = [];
    }

    // Show settings window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
    return true;
  });

  // Audio level updates from renderer
  ipcMain.handle('audio-level', (event, level) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('audio-level', level);
    }
    return true;
  });
}

/**
 * App Lifecycle Management
 */
async function initialize() {
  // Create temp directory if it doesn't exist
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Set up IPC handlers
  setupIPCHandlers();

  // When app is ready
  await app.whenReady();

  try {
    // Hide dock only if not configured to show (macOS only)
    if (isMac && !store.get('showInDock', false)) {
      app.dock.hide();
    }

    // Create main window first
    createMainWindow();

    // Create tray icon
    createTray();

    // Register global shortcut
    const shortcut = store.get('shortcut') || (isMac ? 'Command+Shift+Space' : 'Control+Shift+Space');
    globalShortcut.register(shortcut, toggleRecording);

    // Handle app activation
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      } else if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    });
  } catch (error) {
    console.error('Error initializing app:', error);
  }


  // Prevent default behavior of closing app when all windows are closed
  app.on('window-all-closed', (e) => {
    e.preventDefault();
  });

  // Clean up when app is about to quit
  app.on('will-quit', () => {
    app.isQuitting = true;

    // Unregister shortcuts
    globalShortcut.unregisterAll();

    // Stop recording if active
    if (isRecording) {
      stopRecording();
    }

    // Close windows
    closeOverlayWindow();
  });
}

/**
 * Window Management
 */
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    skipTaskbar: false,
    title: 'HotMic',
    // Use titleBarStyle only on macOS
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
    backgroundColor: '#00000000'
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'));

  // Show in App Switcher when window is shown (macOS specific)
  mainWindow.on('show', () => {
    // Show in dock temporarily while window is open (macOS only)
    if (isMac) {
      app.dock.show();
    }
  });

  // Remove from App Switcher when window is hidden
  mainWindow.on('hide', () => {
    // Hide dock if it's not meant to be visible (macOS only)
    if (isMac && !store.get('showInDock', false)) {
      app.dock.hide();
    }
  });

  // Hide instead of close
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.once('ready-to-show', () => {
    const providerSettings = store.get('providerSettings', { apiKeys: {} });
    const hasAnyKey = store.get('apiKey') || 
                      providerSettings.apiKeys?.google || 
                      providerSettings.apiKeys?.groq || 
                      providerSettings.apiKeys?.openai;
                      
    // Only show on first launch or if no API keys are set
    if (!hasAnyKey) {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createOverlayWindow() {
  // Close existing overlay if any
  closeOverlayWindow();

  // Get screen dimensions to center the overlay
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 340,
    height: 340,
    x: Math.floor(width / 2 - 150),
    y: Math.floor(height / 2 - 150),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    opacity: 1.0,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  overlayWindow.loadFile(path.join(__dirname, '..', 'public', 'overlay.html'));

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
  });
}

function closeOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
    overlayWindow = null;
  }
}

/**
 * Recording Management
 */
function startRecording() {
  if (isRecording) return;

  isRecording = true;
  audioData = [];

  // Show overlay window
  createOverlayWindow();

  // Start recording in overlay
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('start-recording');
  }
}

function stopRecording() {
  if (!isRecording) return;

  isRecording = false;

  // Tell overlay to stop recording
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('stop-recording');
  }
}

// Start the app using a top-level await
(async () => {
  await initialize();
})();