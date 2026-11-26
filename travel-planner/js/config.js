// Shared sync settings (Firebase project "my-travel-planner-57cef").
//
// This config is not a secret: it only says which Firebase project the app
// talks to. Who can read and change trips is controlled by firestore.rules,
// which must be published in the Firebase console (Firestore → Rules).
// Set this back to null to keep trips on each device only.

export const firebaseConfig = {
  apiKey: 'AIzaSyD7PAeOqFAAbRburPk03HOabYyPoHkdioU',
  authDomain: 'my-travel-planner-57cef.firebaseapp.com',
  projectId: 'my-travel-planner-57cef',
  storageBucket: 'my-travel-planner-57cef.firebasestorage.app',
  messagingSenderId: '1045650920939',
  appId: '1:1045650920939:web:e28677a28672473abc35ae',
};

// The trip's AI server (workers/trip-ai, a Cloudflare Worker that holds the
// Anthropic key so every phone on a shared trip can use the AI features).
// Leave as null until it's set up; phones can still add their own key.
export const aiProxyUrl = 'https://trip-ai.ybk9dngrdm.workers.dev';
