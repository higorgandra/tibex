// src/firebaseConfig.ts
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth"; // Importa getAuth

// Sua configuração do Firebase
const firebaseConfig = {
  apiKey: "AIzaSyBZMKACtQClHgV9_4hAwe4npKPwgBi_3ew",
  authDomain: "tibex-com-br.firebaseapp.com",
  projectId: "tibex-com-br",
  storageBucket: "tibex-com-br.appspot.com",
  messagingSenderId: "548414150725",
  appId: "1:548414150725:web:f7e1cc92b24205da582b2c",
};

// Inicializa o Firebase
const app = initializeApp(firebaseConfig);

// Obtém a instância do Firestore
const db = getFirestore(app);

// Obtém a instância do Auth
const auth = getAuth(app);

export { db, auth }; // Exporta db e auth