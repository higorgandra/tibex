// app.js

        // Importações do Firebase (versão 11.6.1)


        import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        // ATUALIZAÇÃO CRÍTICA: Adição de métodos de Login/Registro/Logout
        // NOVO: Adicionado GoogleAuthProvider e signInWithPopup
        import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, signOut, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        // FIX CRÍTICO: Adição de getDocs
        import { getFirestore, doc, getDoc, setDoc, addDoc, onSnapshot, collection, query, where, updateDoc, increment, serverTimestamp, setLogLevel, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

        // ====================================================================
        // === CONFIGURAÇÃO DO FIREBASE (CARREGADA DE firebase-config.js) ===
        // ====================================================================
        // Usamos o projectId como identificador único para as coleções do Firestore
        const appId = firebaseConfig.projectId || 'cip-default-app-id';

        // Variáveis globais
        let app, db, auth, userId = null;
        let isAdmin = false;
        let isRegisteredUser = false; // Indica se o usuário fez login com provedor (Google)
        let allOrders = []; // MANTÉM TODOS OS PEDIDOS PENDENTES AQUI
        let signinAttempted = false; 
        let verifyTimer; 
        let inventoryUnsubscribe = null; // NOVO: Listener de Inventário
        
        // Função para abrir o modal de confirmação
        window.openAdminConfirmModal = function({ title, message, onConfirm }) {
            const modal = document.getElementById('admin-confirm-modal');
            document.getElementById('admin-confirm-title').textContent = title;
            document.getElementById('admin-confirm-message').textContent = message;

            modal.classList.remove('hidden');
            document.body.classList.add('overflow-hidden');

            // Remove listeners antigos
            document.getElementById('admin-confirm-yes').onclick = null;
            document.getElementById('admin-confirm-no').onclick = null;

            // Botão SIM
            document.getElementById('admin-confirm-yes').onclick = () => {
                modal.classList.add('hidden');
                document.body.classList.remove('overflow-hidden');
                if (onConfirm) onConfirm(true);
            };

            // Botão NÃO
            document.getElementById('admin-confirm-no').onclick = () => {
                modal.classList.add('hidden');
                document.body.classList.remove('overflow-hidden');
                if (onConfirm) onConfirm(false);
            };
        };
        // Função para fechar o modal de confirmação
        document.addEventListener('click', function(event) {
            const modal = document.getElementById('admin-confirm-modal');
            if (!modal || modal.classList.contains('hidden')) return;
            // Fecha se clicar exatamente no fundo (overlay), não no conteúdo interno
            if (event.target === modal) {
                modal.classList.add('hidden');
                document.body.classList.remove('overflow-hidden');
            }
        });



        // NOVAS VARIÁVEIS PARA GERENCIAMENTO DE LISTENERS (FIX DE SEGURANÇA)
        let buyOrdersUnsubscribe = null;
        let sellOrdersUnsubscribe = null;
        let adminRenderTimeout = null; // NOVO: Timeout para mensagem de Admin
        
        // Constantes do Negócio
        const SELL_PRICE_PER_25_TC = 5.90; 
        const BUY_PRICE_PER_25_TC = 4.80;  
        
        const MIN_TC_QUANTITY = 25;
        // NOVO: E-mail do Administrador para verificação direta
        const ADMIN_UID = "cAB72OOZXfgffWXh8Kbyxoo3cFo1"; // Certifique-se que este valor é importado corretamente
        let currentOrderId = null; // Para rastreio do pedido atual na tela PIX

        // Lógica de Timeout e Sessão
        const INACTIVITY_TIMEOUT = 900000; // 15 minutos em milissegundos
        let timeoutID;
        
        // NOVO: Flag para o Módulo WebAssembly
        let wasmReady = false; 
        let Module = {}; // Objeto global do Emscripten

        setLogLevel('Debug'); 

        /**
         * NOVO: Reseta o temporizador de inatividade.
         */
        function resetInactivityTimer() {
            clearTimeout(timeoutID);
            // Só monitora inatividade se houver um usuário logado (Admin ou Cliente)
            if (isRegisteredUser) { 
                timeoutID = setTimeout(handleAutoLogout, INACTIVITY_TIMEOUT);
            }
        }

        /**
         * NOVO: Realiza o logout automático.
         */
        async function handleAutoLogout() {
            if (isRegisteredUser) {
                console.log("Sessão expirada por inatividade. Fazendo logout.");
                // Define o marcador para garantir que o próximo load peça login
                sessionStorage.setItem('forced_logout', 'true');
                await signOut(auth);
                window.location.reload();
            }
        }

        // Bloqueia evento de cópia
        document.addEventListener('copy', function(e) {
            e.preventDefault();
        });

        // Bloqueia toque longo (mobile) que abre menu de copiar
        document.addEventListener('touchstart', function(e) {
            if (e.targetTouches.length > 1) {
                e.preventDefault();
            }
        }, { passive: false });

        document.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });


        /**
         * Inicializa o Firebase e a Autenticação.
         */
        async function initializeFirebase() {
            try {
                // VERIFICAÇÃO CRÍTICA DE SESSÃO
                const forcedLogout = sessionStorage.getItem('forced_logout');
                if (forcedLogout === 'true') {
                    // Se a página foi fechada ou recarregada após um logout, força a limpeza do Firebase.
                    sessionStorage.removeItem('forced_logout');
                    await signOut(getAuth(initializeApp(firebaseConfig))); // Garante que qualquer sessão anterior seja limpa.
                    console.log("Forçado logout inicial para limpar sessão anterior.");
                }

                // INICIALIZAÇÃO NORMAL
                app = initializeApp(firebaseConfig);
                db = getFirestore(app);
                auth = getAuth(app);
                 
                // Autenticação
                onAuthStateChanged(auth, async (user) => {
                    userId = user ? user.uid : null;
                    isRegisteredUser = user && !user.isAnonymous; 
                    
                    if (user) {
                        // NOVO: A checagem de Admin agora é feita EXCLUSIVAMENTE pelo e-mail
                        isAdmin = (user.uid === ADMIN_UID);
                        
                        // 2. Inicializa os listeners de pedidos para o Admin
                        if (isAdmin) {
                            setupAdminPanel(); // Configura os listeners de pedidos globais (apenas Admin)
                            window.showAdminPanel(); // Abre o painel automaticamente para o Admin
                        } else {
                            stopAdminListeners(); // Garante que listeners não essenciais parem após o login de um cliente normal
                            window.showClientView(); // Garante que clientes vejam a tela de cliente
                        }
                        
                        // Inicia ou reseta o timer de inatividade apenas após login
                        resetInactivityTimer(); 
                        
                    } else {
                        // FIX: Removemos o token e a lógica de login anônimo de inicialização. 
                        // Forçamos o fallback para anônimo apenas se a UI precisar do userId para formulários
                        // FIX: Only attempt anonymous sign-in if it hasn't been tried and there's no user.
                        // This prevents re-attempts on logout.
                        if (!auth.currentUser && !signinAttempted) {
                            signinAttempted = true; 
                            try {
                                // Não usamos mais initialAuthToken. Tentamos apenas o anônimo simples.
                                await signInAnonymously(auth); 
                            } catch (e) {
                                showMessage("Falha na sessão anônima. Funcionalidades limitadas.", "bg-red-500");
                                console.warn("Tentativa de sign-in inicial falhou:", e.message);
                            }
                        }
                        // Garante que a tela de cliente seja visível se estiver deslogado/anônimo
                        window.showClientView();
                    }
                    
                    updateUserMenu(); // Atualiza o menu de perfil para refletir o estado de login
                    updateFormStates(); // NOVO: Atualiza o estado dos formulários (email e botões)
                    
                    // ATUALIZAÇÃO DA INTERFACE (DECOUPLED)
                    document.getElementById('loading-state').classList.add('hidden');
                    document.getElementById('main-content').classList.remove('hidden');
                }); 

            } catch (error) {
                console.error("Erro ao inicializar Firebase ou Autenticação:", error);
                document.getElementById('loading-state').innerHTML = `<p class="text-red-500">Erro de inicialização: ${error.message}</p>`;
            }
        }
        
        // --- LÓGICA DE AUTENTICAÇÃO E PERFIL ---

        /**
         * Alterna a visibilidade do menu de perfil
         */
        window.toggleAuthMenu = function() {
            const menu = document.getElementById('auth-menu');
            menu.classList.toggle('hidden');
        }
        
        /**
         * NOVO: Função para fechar o dropdown de perfil.
         */
        function closeAuthMenuDropdown() {
            document.getElementById('auth-menu').classList.add('hidden');
        }

        /**
         * Atualiza o menu de perfil baseado no estado de login
         */
        function updateUserMenu() {
            const menuContent = document.getElementById('auth-menu-content');
            let menuHtml = '';
            
            if (isRegisteredUser) {
                // Usuário Logado (Google)
                if (isAdmin) {
                    // ADM: Painel Admin e Sair
                    menuHtml += `<a href="#" onclick="showAdminPanel(); toggleAuthMenu();" class="block px-4 py-2 text-sm text-yellow-300 hover:bg-gray-700">Painel Admin</a>`;
                    menuHtml += `<a href="#" onclick="handleLogout(); toggleAuthMenu();" class="block px-4 py-2 text-sm text-red-400 hover:bg-gray-700">Sair</a>`;
                } else {
                    // Cliente Logado
                    menuHtml += `<a href="#" onclick="showOrderHistory(); toggleAuthMenu();" class="block px-4 py-2 text-sm text-white hover:bg-gray-700">Histórico de Pedidos</a>`;
                    menuHtml += `<a href="#" onclick="handleLogout(); toggleAuthMenu();" class="block px-4 py-2 text-sm text-red-400 hover:bg-gray-700">Sair</a>`;
                }
                document.getElementById('user-icon').classList.add('border-green-400');
            } else {
                // Usuário Anônimo ou Deslogado
                menuHtml += `<a href="#" onclick="showModal('google-login-modal'); toggleAuthMenu();" class="block px-4 py-2 text-sm text-yellow-300 hover:bg-gray-700">Fazer Login</a>`;
                document.getElementById('user-icon').classList.remove('border-green-400');
            }
            menuContent.innerHTML = menuHtml;
        }

        /**
         * Lida com o Login via Google.
         */
        window.handleGoogleLogin = async function() {
            // Se estiver logado, reseta o timer
            if (isRegisteredUser) resetInactivityTimer();
            
            const provider = new GoogleAuthProvider();
            
            try {
                // Força o pop-up, o que é mais estável
                await signInWithPopup(auth, provider);
                // A lógica de Admin e redirecionamento é tratada em onAuthStateChanged
                hideAllModals();
            } catch (error) {
                console.error("Erro no Login Google:", error);
                // O erro "popup-closed-by-user" é comum, não precisa de alerta vermelho
                if (error.code !== 'auth/popup-closed-by-user') {
                    showMessage(`Erro de Login: ${error.message.replace('Firebase:', '')}`, 'bg-red-500');
                }
            }
        }
        
        /**
         * Funções de cópia de domínio removidas, pois a configuração é real e fixa.
         */

        /**
         * Lida com o logout.
         */
        window.handleLogout = async function() {
            // Desabilita o botão de perfil para evitar cliques rápidos
            const userIcon = document.getElementById('user-icon');
            userIcon.disabled = true;
            userIcon.classList.add('opacity-50', 'cursor-not-allowed');
            
            try {
                // Limpa o timer de inatividade
                clearTimeout(timeoutID);
                
                // FIX: Desativa os listeners de Admin antes de sair
                stopAdminListeners();
                
                // 1. Apenas faz o sign out
                await signOut(auth);
                
                // 2. CORREÇÃO CRÍTICA: Em vez de forçar o sign-in anônimo (que falha com admin-restricted-operation),
                // forçamos o refresh da página. O onAuthStateChanged tratará o sign-in anônimo na inicialização.
                // NOVO: Define o marcador para forçar o login na próxima vez
                sessionStorage.setItem('forced_logout', 'true');
                
                showMessage("Sessão encerrada com sucesso. Recarregando...", 'bg-green-600'); 
                
                setTimeout(() => {
                    window.location.reload();
                }, 2000); // Delay de 2 segundos

            } catch (error) {
                // Se der erro, reabilita o botão e tenta novamente o fluxo de segurança
                userIcon.disabled = false;
                userIcon.classList.remove('opacity-50', 'cursor-not-allowed');

                // Silencia o erro de permissão ou admin-restricted que é esperado e força o reload
                if (error.code === 'permission-denied' || error.code === 'auth/admin-restricted-operation' || error.message.includes('permission')) {
                    console.warn("Logout: Erro esperado de limpeza de sessão. Recarregando...");
                    // NOVO: Define o marcador para forçar o login na próxima vez
                    sessionStorage.setItem('forced_logout', 'true');
                    
                    showMessage("Sessão encerrada com sucesso. Recarregando...", 'bg-green-600');
                    setTimeout(() => {
                        window.location.reload();
                    }, 2000); // Delay de 2 segundos
                    return;
                }
                
                console.error("Erro inesperado ao fazer logout:", error);
                showMessage("Erro ao encerrar a sessão. Tente novamente.", 'bg-red-500');
            }
        }
        
        // --- NOVO: LÓGICA DE ESTADO DO FORMULÁRIO (E-MAIL e BOTÕES) ---

        function updateFormEmails() {
            const buyEmail = document.getElementById('buy-email');
            const sellEmail = document.getElementById('sell-email');
            
            const submitBuyButton = document.getElementById('buy-submit-button');
            const submitSellButton = document.getElementById('sell-submit-button');


            if (isRegisteredUser && auth.currentUser && auth.currentUser.email) {
                const email = auth.currentUser.email;
                
                // 1. Preenchimento e Bloqueio de E-mail
                buyEmail.value = email;
                sellEmail.value = email;
                buyEmail.placeholder = email;
                sellEmail.placeholder = email;
                buyEmail.classList.add('cursor-not-allowed', 'focus:ring-yellow-500');
                sellEmail.classList.add('cursor-not-allowed', 'focus:ring-blue-500');

                // 2. Habilitação de Botões (agora controlada pela validação)
                submitBuyButton.textContent = 'Gerar PIX e Finalizar Compra';
                submitSellButton.textContent = 'Gerar Pedido de Venda';
                validateAndToggleButtonState('buy'); // Valida o estado inicial do botão de compra
                validateAndToggleButtonState('sell'); // Valida o estado inicial do botão de venda
            } else {
                // 1. Campos de E-mail vazios e com placeholder
                buyEmail.value = '';
                sellEmail.value = '';
                buyEmail.placeholder = 'Faça login para preenchimento automático';
                sellEmail.placeholder = 'Faça login para preenchimento automático';
                buyEmail.classList.remove('cursor-not-allowed');
                sellEmail.classList.remove('cursor-not-allowed');

                // 2. Desabilitação Visual (mantém o botão ativo para o clique)
                submitBuyButton.textContent = 'FAZER LOGIN PARA FINALIZAR';
                submitSellButton.textContent = 'FAZER LOGIN PARA FINALIZAR';
                submitBuyButton.classList.add('opacity-50', 'cursor-not-allowed');
                submitSellButton.classList.add('opacity-50', 'cursor-not-allowed');
                
                // NOVO FIX: Adiciona a lógica de abrir o modal de login no clique
                submitBuyButton.onclick = (e) => { e.preventDefault(); showModal('google-login-modal'); };
                submitSellButton.onclick = (e) => { e.preventDefault(); showModal('google-login-modal'); };
            }
        }
        
        window.updateFormStates = function() {
            updateFormEmails();
        }

        /**
         * NOVO: Valida os campos do formulário e habilita/desabilita o botão de submit.
         */
        function validateAndToggleButtonState(type) {
            if (!isRegisteredUser) {
                // Se não estiver logado, a lógica é outra (mostrar modal de login)
                const buyButton = document.getElementById('buy-submit-button');
                const sellButton = document.getElementById('sell-submit-button');
                buyButton.classList.add('opacity-50', 'cursor-not-allowed');
                sellButton.classList.add('opacity-50', 'cursor-not-allowed');
                buyButton.onclick = (e) => { e.preventDefault(); showModal('google-login-modal'); };
                sellButton.onclick = (e) => { e.preventDefault(); showModal('google-login-modal'); };
                return;
            }

            let isValid = true;
            const button = document.getElementById(`${type}-submit-button`);

            if (type === 'buy') {
                const charName = document.getElementById('buy-character-name').value.trim();
                const worldInput = document.getElementById('buy-world');
                const tcQuantity = parseInt(document.getElementById('buy-tc-quantity').value);

                isValid = charName && worldInput.classList.contains('text-green-600') && !isNaN(tcQuantity) && tcQuantity >= MIN_TC_QUANTITY;
            } else if (type === 'sell') {
                const charName = document.getElementById('sell-character-name').value.trim();
                const worldInput = document.getElementById('sell-world');
                const tcQuantity = parseInt(document.getElementById('sell-tc-quantity').value);
                const pixKey = document.getElementById('sell-pix-key').value.trim();
                const pixKeyType = document.getElementById('sell-pix-key-type').value;

                isValid = charName && worldInput.classList.contains('text-green-600') && !isNaN(tcQuantity) && tcQuantity >= MIN_TC_QUANTITY && pixKey && pixKeyType;
            }

            if (isValid) {
                button.classList.remove('opacity-50', 'cursor-not-allowed');
                button.disabled = false;
                button.onclick = null; // Permite o submit padrão do formulário
                // NOVO: Restaura o texto original do botão quando o formulário é válido
                button.textContent = type === 'buy'
                    ? 'Gerar PIX e Finalizar Compra'
                    : 'Gerar Pedido de Venda';
            } else {
                button.classList.add('opacity-50', 'cursor-not-allowed');
                button.disabled = true;
                // NOVO: Altera o texto para indicar que os campos precisam ser preenchidos
                button.textContent = 'Preencha seus dados';
                // Previne o submit caso o botão seja clicado de alguma forma
                button.onclick = (e) => e.preventDefault();
            }
        }
        
        // --- LÓGICA DE HISTÓRICO DE PEDIDOS ---
        let userHistoryOrders = []; // Armazena os pedidos do usuário para filtragem rápida

        /**
         * Exibe o histórico de pedidos do usuário logado (Compra e Venda).
         */
        window.showOrderHistory = async function() {
            // Se estiver logado, reseta o timer
            if (isRegisteredUser) resetInactivityTimer();
            
            if (!isRegisteredUser) {
                showMessage("Você precisa estar logado para ver o histórico.", 'bg-red-500');
                return;
            }
            
            // Oculta views não relacionadas
            document.getElementById('main-transaction-view').classList.add('hidden');
            document.getElementById('admin-view').classList.add('hidden');
            
            // Exibe a view de histórico
            const historyView = document.getElementById('user-history-view');
            historyView.classList.remove('hidden');
            
            const historyList = document.getElementById('history-orders-list');
            historyList.innerHTML = '<p class="text-gray-400 p-4 text-center">Buscando seu histórico...</p>';

            // Limpa o histórico local antes de uma nova busca
            userHistoryOrders = [];
            const orders = [];

            try {
                // 1. Busca pedidos de COMPRA do usuário logado
                const buyQuery = query(collection(db, `artifacts/${appId}/public/data/cip_buy_orders`), where("userId", "==", userId));
                const buySnapshot = await getDocs(buyQuery);
                buySnapshot.forEach(doc => orders.push({ id: doc.id, type: 'COMPRA', ...doc.data() }));
            } catch (e) {
                console.warn("Não foi possível carregar o histórico de compras (ou não há nenhum):", e.message);
            }

            try {
                // 2. Busca pedidos de VENDA do usuário logado
                const sellQuery = query(collection(db, `artifacts/${appId}/public/data/cip_sell_orders`), where("userId", "==", userId));
                const sellSnapshot = await getDocs(sellQuery);
                sellSnapshot.forEach(doc => orders.push({ id: doc.id, type: 'VENDA', ...doc.data() }));
            } catch (e) {
                console.warn("Não foi possível carregar o histórico de vendas (ou não há nenhum):", e.message);
            }
            
            // Ordena todos os pedidos encontrados por data de criação (mais recente primeiro)
            userHistoryOrders = orders.sort((a, b) => (b.createdAt?.toMillis ? b.createdAt.toMillis() : 0) - (a.createdAt?.toMillis ? a.createdAt.toMillis() : 0));
            
            // Mapeamento de status para exibição no Histórico
            const statusMap = {
                'Aguardando Pagamento': { text: 'Aguardando pagamento', color: 'bg-yellow-500' },
                'Aguardando Transferência': { text: 'Aguardando TC (Sua Ação)', color: 'bg-yellow-500' },
                'PagoEmFila': { text: 'Pago em Fila (Aguardando Envio)', color: 'bg-purple-600' },
                'Transferido': { text: 'Pedido Enviado', color: 'bg-green-600' }, // Compra
                'PIX Enviado': { text: 'Pedido Enviado', color: 'bg-green-600' },  // Venda
                'Cancelado': { text: 'Cancelado', color: 'bg-red-600' },
            };

            // Renderiza a visualização inicial (padrão: Compras), mesmo que a lista esteja vazia.
            // A função filterHistory já sabe como lidar com uma lista vazia.
            filterHistory('COMPRA');
        }

        /**
         * NOVO: Filtra e renderiza o histórico de pedidos do usuário por tipo (COMPRA/VENDA).
         * FIX: Corrigido erro de sintaxe que impedia a função de funcionar.
         */
        window.filterHistory = function(type) {
            const historyList = document.getElementById('history-orders-list');
            const buyTab = document.getElementById('history-buy-tab');
            const sellTab = document.getElementById('history-sell-tab');

            // Atualiza a aparência das abas para seguir o padrão (Compra=Amarelo, Venda=Azul)
            if (type === 'COMPRA') {
                buyTab.classList.add('bg-yellow-600', 'text-gray-900');
                buyTab.classList.remove('bg-gray-700', 'text-white');
                sellTab.classList.add('bg-gray-700', 'text-white');
                sellTab.classList.remove('bg-blue-600', 'text-white');
            } else { // VENDA
                sellTab.classList.add('bg-blue-600', 'text-white');
                sellTab.classList.remove('bg-gray-700', 'text-white');
                buyTab.classList.add('bg-gray-700', 'text-white');
                buyTab.classList.remove('bg-yellow-600', 'text-gray-900');
            }

            const filteredOrders = userHistoryOrders.filter(order => order.type === type);

            if (filteredOrders.length === 0) {
                historyList.innerHTML = `<p class="text-yellow-400 p-4 text-center">Nenhum pedido de ${type.toLowerCase()} encontrado.</p>`;
                return;
            }

            // Mapeamento de status (reutilizado de showOrderHistory)
            const statusMap = {
                'Aguardando Pagamento': { text: 'Aguardando pagamento', color: 'bg-yellow-500' },
                'Aguardando Transferência': { text: 'Aguardando TC (Sua Ação)', color: 'bg-yellow-500' },
                'PagoEmFila': { text: 'Pago em Fila (Aguardando Envio)', color: 'bg-purple-600' },
                'Transferido': { text: 'Pedido Enviado', color: 'bg-green-600' },
                'PIX Enviado': { text: 'Pedido Enviado', color: 'bg-green-600' },
                'Cancelado': { text: 'Cancelado', color: 'bg-red-600' }
            };

            historyList.innerHTML = filteredOrders.map(order => {
                const date = order.createdAt ? new Date(order.createdAt.seconds * 1000).toLocaleString() : 'N/A';
                const isBuy = order.type === 'COMPRA';
                const displayStatus = statusMap[order.status] || { text: order.status, color: 'bg-gray-600' };

                const finalAmountFormatted = order.finalAmount && !isNaN(order.finalAmount)
                    ? order.finalAmount.toFixed(2).replace('.', ',')
                    : '0,00';

                const amountDisplay = isBuy
                    ? `<p class="text-white">Pagou: <span class="font-bold text-green-400">R$ ${finalAmountFormatted}</span></p>`
                    : `<p class="text-white">Recebeu: <span class="font-bold text-green-400">R$ ${finalAmountFormatted}</span></p>`;

                const border = isBuy ? 'border-l-4 border-yellow-500' : 'border-l-4 border-blue-500';
                const typeTag = isBuy ? 'bg-yellow-500 text-gray-900' : 'bg-blue-500 text-white';

                let actionDetails = ''; // Unificado para detalhes de compra ou venda
                if (isBuy && order.status === 'Aguardando Pagamento') {
                    actionDetails = `
                        <div class="mt-3 bg-gray-600 p-3 rounded-lg text-sm">
                            <p class="font-bold text-yellow-300 mb-1">Detalhes do PIX:</p>
                            <p>Chave: ${order.pixKey || 'N/A'}</p>
                            <p>Valor: R$ ${finalAmountFormatted}</p>
                            <p class="text-xs text-red-300 mt-2">Faça o PIX para o e-mail: 40028922@tibex.com.br</p>
                        </div>
                    `;
                } else if (!isBuy && order.status === 'Aguardando Transferência') {
                    // NOVO: Adiciona detalhes da transferência para pedidos de VENDA
                    actionDetails = `
                        <div class="mt-3 bg-gray-600 p-3 rounded-lg text-sm">
                            <p class="font-bold text-yellow-300 mb-1">Ação Necessária:</p>
                            <p>Transfira ${order.tcQuantity} TC para o personagem:</p>
                            <p class="font-bold text-lg text-white">${order.platformCharacter || 'Tibex Bank'}</p>
                            <p class="text-xs text-gray-400 mt-1">Mundo: ${order.world}</p>
                        </div>
                    `;
                }

                return `
                    <div class="bg-gray-700 p-4 mb-3 rounded-lg shadow-md ${border}">
                        <div class="flex justify-between items-start mb-2">
                            <div>
                                <span class="text-xs font-semibold p-1 rounded ${typeTag}">${order.type}</span>
                                <span class="font-bold text-sm p-1 rounded ${displayStatus.color} text-white ml-2">${displayStatus.text}</span>
                            </div>
                            <span class="text-sm text-gray-400 text-right">${date}</span>
                        </div>
                        
                        <div class="mt-2 mb-3">
                            <p class="text-xs text-gray-400">ID do Pedido:</p>
                            <p class="text-sm font-mono text-yellow-300 break-all">${order.id}</p>
                        </div>
                        <p class="text-white">Coins: <span class="font-bold text-lg">${order.tcQuantity} TC</span></p>
                        ${amountDisplay}
                        <p class="mt-2 text-sm text-gray-400">Char: ${order.characterName} (${order.world})</p>
                        ${actionDetails}
                    </div>
                `;
            }).join('');
        };
        
        /**
         * Retorna à visão principal de transação
         */
        window.showTransactionView = function() {
            // NOVO FIX: Garante que a view principal e as abas estejam visíveis
            document.getElementById('main-transaction-view').classList.remove('hidden');
            document.getElementById('transaction-tabs-container').classList.remove('hidden');
            
            // Oculta views não relacionadas
            document.getElementById('user-history-view').classList.add('hidden');
            document.getElementById('admin-view').classList.add('hidden');
            
            // Garante que o estado de Pagamento PIX NÃO seja restaurado
            document.getElementById('pix-payment-container').classList.add('hidden'); // CRÍTICO: ESCONDE PIX
            document.getElementById('sell-confirmation-container').classList.add('hidden');
            
            // Garante que a COMPRA (o formulário) seja reexibida, e não o Pagamento PIX
            document.getElementById('buy-form-container').classList.remove('hidden'); 
            
            // FIX: Chama switchTab apenas para redefinir o estado visual das abas e garantir que "Comprar TC" esteja ativo
            window.switchTab('buy-tab');
        }


        /**
         * FUNÇÃO DE SEGURANÇA: Limpa strings para evitar XSS antes de serem inseridas no DOM.
         */
        function sanitizeInput(input) {
            if (!input) return '';
            const div = document.createElement('div');
            div.textContent = input;
            return div.innerHTML; // Retorna o texto codificado (safe HTML)
        }
        
        // --- FUNÇÕES DE VERIFICAÇÃO DE PERSONAGEM (MUITO IMPORTANTE) ---
        
        /**
         * Debounce para evitar chamadas excessivas à API externa.
         */
        window.debounceVerify = function(type) {
            // Se estiver logado, reseta o timer
            if (isRegisteredUser) resetInactivityTimer();
            
            clearTimeout(verifyTimer);
            
            const charNameInput = document.getElementById(`${type}-character-name`);
            const charName = charNameInput.value.trim();
            const worldInput = document.getElementById(`${type}-world`);
            
            // Bloqueia sugestões do teclado
            charNameInput.setAttribute('autocomplete', 'off'); 

            // Limpa o campo se o nome for muito curto
            if (charName.length < 3) {
                worldInput.value = '';
                worldInput.placeholder = 'Aguardando nome do personagem...';
                worldInput.classList.remove('text-red-500', 'text-green-600'); // Limpa classes de cor
                return;
        } else {
            // NOVO: Valida o formulário a cada tecla digitada no nome do char
            validateAndToggleButtonState(type);
            }
            
            worldInput.placeholder = 'Buscando servidor...';
            worldInput.value = '';
            worldInput.classList.remove('text-red-500', 'text-green-600'); // Limpa classes de cor
            
            verifyTimer = setTimeout(() => {
                verifyCharacterWorld(charName, worldInput);
            }, 800); // 800ms de debounce
        }

        /**
         * Verifica o servidor do personagem usando a API TibiaData (CORS-friendly).
         */
        async function verifyCharacterWorld(characterName, worldInput) {
            // Se estiver logado, reseta o timer
            if (isRegisteredUser) resetInactivityTimer();

            // Formata o nome do personagem para a URL (substitui espaços por %20)
            const formattedName = characterName.replace(/\s/g, '%20');
            const apiUrl = `https://api.tibiadata.com/v4/character/${formattedName}`;

            worldInput.value = ''; 
            worldInput.placeholder = 'Verificando...';
            worldInput.classList.remove('text-red-500', 'text-green-600'); // Garante estado neutro antes da busca
            
            try {
                const response = await fetch(apiUrl);
                const data = await response.json();
                
                // CRÍTICO: Acessando a estrutura aninhada: data.character.character.world
                const characterDetails = data.character?.character;

                // Verifica se a resposta HTTP for OK e se a estrutura aninhada do personagem estiver correta
                if (response.ok && characterDetails && characterDetails.world) {
                    const worldName = characterDetails.world;
                    worldInput.value = worldName;
                    worldInput.placeholder = worldName; // Mantém o nome como placeholder/valor
                    worldInput.classList.remove('text-red-500');
                    worldInput.classList.add('text-green-600'); // Cor de sucesso
                    // NOVO: Valida o formulário após encontrar o servidor
                    validateAndToggleButtonState(worldInput.id.startsWith('buy') ? 'buy' : 'sell');
                    // showMessage(`Servidor '${worldName}' encontrado!`, 'bg-green-600');
                } else {
                    // Se a resposta falhar, loga o detalhe para diagnóstico (ex: 404)
                    console.warn("Character not found or API error details:", data.information);
                    worldInput.value = 'Personagem não encontrado!'; // Define o valor para visibilidade máxima (em vermelho)
                    worldInput.placeholder = 'Personagem não encontrado!';
                    worldInput.classList.add('text-red-500');
                    worldInput.classList.remove('text-green-600'); // Remove cor de sucesso
                    // NOVO: Revalida o formulário, que agora ficará inválido
                    validateAndToggleButtonState(worldInput.id.startsWith('buy') ? 'buy' : 'sell');
                    showMessage("Erro: Nome do personagem errado ou inexistente.", 'bg-red-500');
                }
            } catch (error) {
                console.error("Erro na comunicação com a API de Tibia:", error);
                worldInput.value = 'Erro de conexão com a API.';
                worldInput.placeholder = 'Erro de conexão com a API.';
                worldInput.classList.add('text-red-500');
                worldInput.classList.remove('text-green-600'); // Remove cor de sucesso
                validateAndToggleButtonState(worldInput.id.startsWith('buy') ? 'buy' : 'sell');
                showMessage("Erro ao verificar personagem. Tente novamente.", 'bg-red-500');
            }
        }
        
        // --- FUNÇÕES GERAIS DE CLIENTE (COMPRA/VENDA) ---

        /**
         * NOVO: Limpa todos os campos dos formulários de compra e venda.
         * Chamado ao trocar de aba para evitar que dados de um formulário persistam no outro.
         */
        function clearTransactionForms() {
            // Limpa formulário de Compra
            const buyTcQuantity = document.getElementById('buy-tc-quantity');
            if (buyTcQuantity) buyTcQuantity.value = MIN_TC_QUANTITY;

            const buyCharName = document.getElementById('buy-character-name');
            if (buyCharName) buyCharName.value = '';

            const buyWorld = document.getElementById('buy-world');
            if (buyWorld) {
                buyWorld.value = '';
                buyWorld.placeholder = 'Aguardando nome do personagem...';
                buyWorld.classList.remove('text-red-500', 'text-green-600');
            }

            // Limpa formulário de Venda
            const sellTcQuantity = document.getElementById('sell-tc-quantity');
            if (sellTcQuantity) sellTcQuantity.value = MIN_TC_QUANTITY;

            const sellPixKeyType = document.getElementById('sell-pix-key-type');
            if (sellPixKeyType) sellPixKeyType.value = 'CPF'; // Reseta para o padrão

            const sellPixKey = document.getElementById('sell-pix-key');
            if (sellPixKey) sellPixKey.value = '';

            const sellCharName = document.getElementById('sell-character-name');
            if (sellCharName) sellCharName.value = '';

            const sellWorld = document.getElementById('sell-world');
            if (sellWorld) {
                sellWorld.value = '';
                sellWorld.placeholder = 'Aguardando nome do personagem...';
                sellWorld.classList.remove('text-red-500', 'text-green-600');
            }

            // Recalcula os preços para refletir os valores padrão
            window.calculateBuyPrice();
            window.calculateSellPrice();

            // NOVO: Revalida os botões, que agora estarão desabilitados
            validateAndToggleButtonState('buy');
            validateAndToggleButtonState('sell');
        }

        /**
         * Alterna entre as abas de compra e venda
         */
        window.switchTab = function(tabName) {
            // Se estiver logado, reseta o timer
            if (isRegisteredUser) resetInactivityTimer();

            // NOVO: Limpa os formulários ao trocar de aba
            clearTransactionForms();
            
            const tabs = ['buy-tab', 'sell-tab'];
            const contents = ['buy-form-container', 'sell-form-container'];
            
            // Garante que as abas de transação estejam visíveis ao trocar de aba (caso o Histórico estivesse aberto)
            document.getElementById('transaction-tabs-container').classList.remove('hidden'); 

            tabs.forEach(tab => {
                const element = document.getElementById(tab);
                // Define as classes padrão/inativas
                element.classList.add('bg-gray-700', 'text-white');
                element.classList.remove('bg-yellow-600', 'bg-blue-600', 'text-gray-900');


                if (tab === tabName) {
                    // Ativa a aba
                    if (tabName === 'buy-tab') {
                         // COMPRA: Amarelo
                        element.classList.add('bg-yellow-600', 'text-gray-900');
                        element.classList.remove('bg-gray-700', 'text-white');
                    } else if (tabName === 'sell-tab') {
                        // VENDA: Azul
                        element.classList.add('bg-blue-600', 'text-white');
                        element.classList.remove('bg-gray-700', 'text-white');
                    }
                }
            });

            contents.forEach(content => {
                const element = document.getElementById(content);
                if (content.includes(tabName.split('-')[0])) {
                    element.classList.remove('hidden');
                } else {
                    element.classList.add('hidden');
                }
            });
            
            // Oculta a confirmação de pagamento/transferência ao trocar de aba
            document.getElementById('pix-payment-container').classList.add('hidden');
            document.getElementById('sell-confirmation-container').classList.add('hidden');
        }

        /**
         * Retorna a cor para o status
         */
        function getStatusColor(status) {
            switch (status) {
                case 'Aguardando Pagamento':
                case 'Aguardando Transferência':
                    return 'bg-yellow-600';
                case 'Transferido':
                case 'PIX Enviado':
                case 'Pedido Enviado': // Novo status
                    return 'bg-green-600';
                case 'PagoEmFila': // Novo status
                    return 'bg-purple-600';
                case 'Cancelado':
                    return 'bg-red-600';
                default:
                    return 'bg-gray-600';
            }
        }


        // --- LÓGICA DE COMPRA (USUÁRIO COMPRA TC DE CipCoins) ---

        /**
         * NOVO: Abre o popup de resumo do pedido.
         */
        window.openOrderSummaryPopup = function({ title, details, onConfirm }) {
            const modal = document.getElementById('order-summary-modal');
            document.getElementById('order-summary-title').textContent = title;
            
            const contentEl = document.getElementById('order-summary-content');
            contentEl.innerHTML = `
                <p><strong>Nome:</strong> ${details.userName}</p>
                <p><strong>Email:</strong> ${details.email}</p>
                <p><strong>Personagem:</strong> ${details.characterName} (${details.world})</p>
                <p><strong>Quantidade:</strong> ${details.tcQuantity} TC</p>
                <p><strong>Valor:</strong> <span class="font-bold text-green-400">R$ ${details.finalAmount.toFixed(2).replace('.', ',')}</span></p>
            `;

            // FIX: Adiciona z-index para garantir que o modal fique na frente de outros elementos
            modal.classList.add('z-50');

            modal.classList.remove('hidden');
            document.body.classList.add('overflow-hidden');

            document.getElementById('order-summary-yes').onclick = () => {
                modal.classList.add('hidden');
                document.body.classList.remove('overflow-hidden');
                if (onConfirm) onConfirm(true);
            };

            document.getElementById('order-summary-no').onclick = () => {
                modal.classList.add('hidden');
                document.body.classList.remove('overflow-hidden');
                if (onConfirm) onConfirm(false);
            };

            // NOVO: Adiciona listener para fechar o modal ao clicar no overlay (fundo escuro)
            modal.onclick = (event) => {
                // Se o clique for exatamente no elemento do modal (o overlay), e não em seus filhos
                if (event.target === modal) {
                    modal.classList.add('hidden');
                    document.body.classList.remove('overflow-hidden');
                }
            };
        };

        /**
         * Função de SEGURANÇA para calcular o preço final com base nas CONSTANTES.
         * Esta é a função crítica que será (simuladamente) substituída por Wasm.
         * Garante que a lógica de precificação seja a única fonte de verdade.
         * @param {number} quantity - Quantidade de TC desejada.
         * @param {number} priceConst - Preço por pacote de 25 TC (SELL_PRICE_PER_25_TC ou BUY_PRICE_PER_25_TC).
         * @returns {number} O valor final da transação.
         */
        function calculateFinalPriceSecure(quantity, priceConst) {
            // Se o módulo Wasm estiver pronto, use a função C++ para cálculo (Anti-Tampering)
            if (wasmReady) {
                try {
                    // Chamada ao Wasm: ccall(função C++, tipo retorno, tipos argumentos, array argumentos)
                    const result = Module.ccall(
                        'calculate_final_price_wasm', // Nome da função C++
                        'number',                     // Tipo de retorno (float/number)
                        ['number', 'number'],         // Tipos dos argumentos (int, float)
                        [quantity, priceConst]        // Valores
                    );
                    return parseFloat(result.toFixed(2));
                } catch (e) {
                    // Fallback em caso de erro no Wasm.
                    console.error("Wasm calculation failed, falling back to JS.", e);
                }
            }
            
            // Lógica de Fallback (Vulnerável à Inspeção/Tampering, mas garante funcionalidade)
            if (isNaN(quantity) || quantity < 1) return 0;
            const calculatedQuantity = Math.ceil(quantity / 25) * 25;
            const totalPackages = calculatedQuantity / 25;
            const totalPrice = (totalPackages * priceConst);
            return parseFloat(totalPrice.toFixed(2));
        }


        /**
         * Calcula o preço baseado na quantidade de Tibia Coins e atualiza a UI.
         */
        function calculateAndCorrectPrice(tcInputId, priceConst, totalDisplayId, tcTransferId, finalAmountId) {
            const tcInput = document.getElementById(tcInputId);
            let value = tcInput.value.trim();
            let quantity = parseInt(value);

            // 1. Calcula o preço seguro (Wasm-based)
            const finalPrice = calculateFinalPriceSecure(quantity, priceConst);
            const calculatedQuantity = Math.ceil(quantity / 25) * 25;


            // Se o campo estiver vazio ou inválido, apenas retorna a exibição do preço base
            if (isNaN(quantity) || quantity < 1) {
                document.getElementById(totalDisplayId).innerText = `R$ 0,00`;
                return; 
            }

            // 2. Atualiza a UI com os valores seguros
            document.getElementById(totalDisplayId).innerText = `R$ ${finalPrice.toFixed(2).replace('.', ',')}`;
            document.getElementById(tcTransferId).value = calculatedQuantity;
            document.getElementById(finalAmountId).value = finalPrice;

            // NOVO: Valida o formulário sempre que o preço é calculado
            validateAndToggleButtonState(tcInputId.startsWith('buy') ? 'buy' : 'sell');
        }

        /**
         * NOVO: Corrige o valor do campo no onblur para garantir o mínimo e o múltiplo de 25.
         */
        window.correctBuyQuantity = function() {
            const tcInput = document.getElementById('buy-tc-quantity');
            let quantity = parseInt(tcInput.value.trim());
            
            // Se o campo estiver vazio ou for apagado, define o mínimo
            if (isNaN(quantity) || quantity < 1) {
                quantity = MIN_TC_QUANTITY;
            } else {
                // Arredonda para o próximo múltiplo de 25
                quantity = Math.ceil(quantity / 25) * 25;
            }

            tcInput.value = quantity;
            calculateAndCorrectPrice('buy-tc-quantity', SELL_PRICE_PER_25_TC, 'buy-total-price-display', 'buy-tc-to-transfer', 'buy-final-amount');
        }

        window.calculateBuyPrice = function() {
            // Apenas calcula no oninput, a correção/arredondamento ocorre no onblur
            calculateAndCorrectPrice('buy-tc-quantity', SELL_PRICE_PER_25_TC, 'buy-total-price-display', 'buy-tc-to-transfer', 'buy-final-amount');
        }
        
        async function proceedWithBuyOrder(orderData) {
            const submitButton = document.getElementById('buy-submit-button');

            // FIX DE SEGURANÇA: Garante que um userId (anônimo ou real) exista antes de prosseguir.
            if (!userId) {
                showMessage("Sua sessão expirou ou é inválida. Recarregue a página e tente novamente.", 'bg-red-500');
                return;
            }

            // Adiciona feedback visual de carregamento
            submitButton.disabled = true;
            submitButton.textContent = 'Processando...';
            submitButton.classList.add('opacity-50', 'cursor-not-allowed');

            try {
                const orderRef = collection(db, `artifacts/${appId}/public/data/cip_buy_orders`);
                const docRef = await addDoc(orderRef, orderData);
                const orderId = docRef.id;
                
                currentOrderId = orderId; 
                
                // Exibe a tela de pagamento PIX
                // FIX: Envolve a chamada em um try/catch para lidar com erros de UI (elementos não encontrados)
                if (!displayPixPayment(orderId, orderData.finalAmount, orderData.pixKey, orderData.pixQrCodeUrl)) {
                    // Se displayPixPayment retornar false, significa que a UI falhou em ser exibida.
                    // A mensagem de erro já foi mostrada por displayPixPayment.
                    throw new Error("Falha ao renderizar a interface de pagamento PIX.");
                }
                showMessage(`Pedido de Compra #${orderId.substring(0, 8)} gerado! Aguardando pagamento...`, 'bg-blue-500');

            } catch (error) {
                console.error("Erro ao gerar pedido de compra:", error);
            } finally {
                // Restaura o estado do botão, independentemente de sucesso ou falha
                submitButton.disabled = false;
                // A função validateAndToggleButtonState irá corrigir o texto e o estado
                validateAndToggleButtonState('buy');
            }
        }

        /**
         * Gera o pedido de Compra e o PIX (simulado)
         */
        window.submitBuyOrder = async function(event) {
            event.preventDefault();
            
            window.correctBuyQuantity();
            
            if (isRegisteredUser) resetInactivityTimer();
            
            if (!isRegisteredUser) {
                showMessage("Erro de segurança: Faça login para gerar o pedido.", 'bg-red-500');
                showModal('google-login-modal');
                return;
            }

            const characterName = document.getElementById('buy-character-name').value.trim();
            const world = document.getElementById('buy-world').value.trim();
            const email = document.getElementById('buy-email').value.trim();
            const tcQuantity = parseInt(document.getElementById('buy-tc-to-transfer').value);
            const worldInput = document.getElementById('buy-world');
            
            const finalAmount = calculateFinalPriceSecure(tcQuantity, SELL_PRICE_PER_25_TC);
            
            if (!worldInput.classList.contains('text-green-600')) {
                 showMessage("O servidor não foi validado. Por favor, corrija o nome do personagem.", 'bg-red-500');
                 return;
            }
            
            if (!characterName || !world || !email || !tcQuantity || isNaN(finalAmount) || finalAmount <= 0) {
                showMessage("Por favor, preencha todos os campos corretamente.", 'bg-red-500');
                return;
            }

            const simulatedPixKey = '40028922@tibex.com.br';
            const simulatedQrCodeUrl = 'https://placehold.co/150x150/000/FFF?text=QR+Code';
            
            const orderData = {
                userId: userId,
                userName: auth.currentUser.displayName, // NOVO: Salva o nome do usuário
                type: 'COMPRA',
                characterName: sanitizeInput(characterName),
                world: sanitizeInput(world),
                email: sanitizeInput(email),
                tcQuantity,
                finalAmount,
                status: 'Aguardando Pagamento',
                pixKey: simulatedPixKey, 
                pixQrCodeUrl: simulatedQrCodeUrl,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            };

            openOrderSummaryPopup({
                title: "Resumo da Compra",
                details: {
                    userName: auth.currentUser.displayName,
                    email: auth.currentUser.email,
                    characterName: characterName,
                    world: world,
                    tcQuantity: tcQuantity,
                    finalAmount: finalAmount
                },
                onConfirm: (confirmed) => {
                    if (confirmed) {
                        proceedWithBuyOrder(orderData);
                    }
                }
            });
        }
        
        /**
         * NOVO: Simula a confirmação automática do PIX (o que a API do banco faria).
         */
        window.simulatePixConfirmation = async function() {
            // Se estiver logado, reseta o timer
            if (isRegisteredUser) resetInactivityTimer();
            
            // FIX CRÍTICO: Checa se é Admin ANTES de tentar atualizar o Firestore.
            if (!isAdmin) {
                showMessage("Ação não autorizada. Apenas o Administrador pode simular a confirmação.", 'bg-red-600');
                return;
            }
            
            if (!currentOrderId) {
                showMessage("Nenhum pedido ativo para confirmar.", 'bg-red-500');
                return;
            }
            
            const pixContainer = document.getElementById('pix-payment-container');
            const titleElement = pixContainer.querySelector('h2');
            const detailsContent = document.getElementById('pix-details-content');
            const confirmationContent = document.getElementById('pix-confirmation-content');
            const simulateButton = document.getElementById('simulate-pix-button');

            try {
                // Atualiza o status para Pago em Fila (pronto para ser processado pelo Admin)
                const docRef = doc(db, `artifacts/${appId}/public/data/cip_buy_orders`, currentOrderId);
                await updateDoc(docRef, {
                    status: 'PagoEmFila',
                    updatedAt: serverTimestamp(),
                    paymentConfirmedAt: serverTimestamp(),
                });
                
                // --- ATUALIZAÇÃO DA UI PARA CONFIRMAÇÃO ---
                titleElement.textContent = 'Pagamento Confirmado!';
                detailsContent.classList.add('hidden');
                simulateButton.classList.add('hidden');
                
                // Preenche o conteúdo de confirmação com o checkmark e mensagem
                confirmationContent.innerHTML = `
                    <div class="text-center">
                        <svg class="w-20 h-20 text-green-500 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                        <p class="text-lg text-white mb-2">Seu pagamento foi recebido com sucesso!</p>
                        <p class="text-gray-400 mb-6">Seu pedido <span class="font-bold text-yellow-400">#${currentOrderId.substring(0, 8)}</span> está na fila para envio. Monitore o status no seu histórico de pedidos.</p>
                        <button onclick="window.showTransactionView()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition-all duration-200">Voltar ao Início</button>
                    </div>
                `;
                confirmationContent.classList.remove('hidden');

                showMessage(`Pagamento confirmado! Pedido #${currentOrderId.substring(0, 8)} está em fila para envio.`, 'bg-purple-600');

            } catch (error) {
                console.error("Erro ao simular confirmação PIX:", error);
                showMessage("Não foi possível processar a confirmação. Tente novamente.", 'bg-red-500');
            }
        }

        /**
         * Exibe a seção de pagamento PIX (simulado) para Compra (Buy Order)
         */
        function displayPixPayment(orderId, amount, pixKey, qrCodeUrl) {
            // Função auxiliar para obter elemento. Retorna null e loga erro se não encontrado.
            const getElement = (id) => {
                const el = document.getElementById(id);
                if (!el) {
                    // Este erro é para o desenvolvedor, indicando um problema no HTML.
                    console.error(`[Developer Error] Elemento com ID '${id}' não foi encontrado no DOM.`);
                    throw new Error(`Elemento '${id}' ausente.`);
                }
                return el; // Retorna o elemento ou null
            };
        
            try {
                // FIX CRÍTICO: Oculta os formulários e abas, mas mantém a 'main-transaction-view' visível
                // para que o 'pix-payment-container' (que está dentro dela) possa ser exibido.
                getElement('buy-form-container').classList.add('hidden');
                getElement('sell-form-container').classList.add('hidden');
                getElement('transaction-tabs-container').classList.add('hidden');
        
                // --- PREPARA A TELA DE PAGAMENTO (ESTADO INICIAL) ---
                const pixContainer = getElement('pix-payment-container');
                const titleElement = pixContainer.querySelector('h2');
                const detailsContent = getElement('pix-details-content');
                const confirmationContent = getElement('pix-confirmation-content');
                const simButton = getElement('simulate-pix-button');
        
                // 1. Reseta o título e o conteúdo
                if (titleElement) {
                    titleElement.textContent = 'Aguardando Pagamento PIX';
                } else {
                    console.error("[Developer Error] Elemento 'h2' dentro de 'pix-payment-container' não encontrado.");
                }
                detailsContent.classList.remove('hidden');
                confirmationContent.classList.add('hidden');
                confirmationContent.innerHTML = ''; // Limpa conteúdo antigo
        
                // 2. Preenche os detalhes do pagamento
                getElement('pix-order-id').innerText = orderId.substring(0, 8);
                getElement('pix-amount').innerText = `R$ ${amount.toFixed(2).replace('.', ',')}`;
                getElement('pix-key-display').innerText = pixKey;
                getElement('pix-qr-code').src = qrCodeUrl;
        
                // 3. Controla a visibilidade do botão de simulação
                simButton.classList.toggle('hidden', !isAdmin);
        
                // 4. Exibe o container principal
                pixContainer.classList.remove('hidden');
                return true; // Sucesso
            } catch (error) {
                // Exibe uma mensagem amigável para o usuário e loga o erro técnico.
                showMessage("Ocorreu um erro ao exibir a tela de pagamento. Verifique o console (F12).", 'bg-red-500');
                return false; // Falha
            }
        }


        // --- LÓGICA DE VENDA (USUÁRIO VENDE TC PARA CipCoins) ---

        /**
         * NOVO: Corrige o valor do campo no onblur para garantir o mínimo e o múltiplo de 25.
         */
        window.correctSellQuantity = function() {
            const tcInput = document.getElementById('sell-tc-quantity');
            let quantity = parseInt(tcInput.value.trim());

            if (isNaN(quantity) || quantity < MIN_TC_QUANTITY) {
                quantity = MIN_TC_QUANTITY;
            } else {
                quantity = Math.ceil(quantity / 25) * 25;
            }

            tcInput.value = quantity;
            calculateAndCorrectPrice('sell-tc-quantity', BUY_PRICE_PER_25_TC, 'sell-total-price-display', 'sell-tc-to-transfer', 'sell-final-amount');
        }

        window.calculateSellPrice = function() {
            calculateAndCorrectPrice('sell-tc-quantity', BUY_PRICE_PER_25_TC, 'sell-total-price-display', 'sell-tc-to-transfer', 'sell-final-amount');
        }

        async function proceedWithSellOrder(orderData) {
            // FIX DE SEGURANÇA: Garante que um userId (anônimo ou real) exista antes de prosseguir.
            if (!userId) {
                showMessage("Sua sessão expirou ou é inválida. Recarregue a página e tente novamente.", 'bg-red-500');
                return;
            }

            try {
                // ATENÇÃO: Mudança de nome na coleção
                const orderRef = collection(db, `artifacts/${appId}/public/data/cip_sell_orders`);
                const docRef = await addDoc(orderRef, orderData);
                const orderId = docRef.id;

                displaySellConfirmation(orderId, orderData.tcQuantity, orderData.platformCharacter, orderData.world, orderData.finalAmount);
                showMessage(`Pedido de Venda #${orderId.substring(0, 8)} gerado! Aguardando sua transferência In-Game...`, 'bg-blue-500');
                
                // Variável global para rastreio
                currentOrderId = orderId; 

            } catch (error) {
                console.error("Erro ao gerar pedido de venda:", error);
                showMessage("Erro ao processar pedido de venda. Tente novamente.", 'bg-red-500');
            }
        }

        /**
         * Gera o pedido de Venda
         */
        window.submitSellOrder = async function(event) {
            event.preventDefault();
            
            // Força a correção final do campo antes da submissão (garantindo o múltiplo e mínimo)
            window.correctSellQuantity();
            
            // Se estiver logado, reseta o timer
            if (isRegisteredUser) resetInactivityTimer();
            
            // Verificação de Login é feita pelo botão. Apenas checagem final.
             if (!isRegisteredUser) {
                showMessage("Erro de segurança: Faça login para gerar o pedido.", 'bg-red-500');
                showModal('google-login-modal');
                return;
            }

            const characterName = document.getElementById('sell-character-name').value.trim();
            const world = document.getElementById('sell-world').value.trim();
            const pixKeyType = document.getElementById('sell-pix-key-type').value.trim();
            const pixKey = document.getElementById('sell-pix-key').value.trim();
            const email = document.getElementById('sell-email').value.trim(); // Email virá do campo readonly
            const tcQuantity = parseInt(document.getElementById('sell-tc-to-transfer').value);
            const worldInput = document.getElementById('sell-world');
            
            // SEGURANÇA 1 (ANTI-TAMPERING): Re-calcula o valor final usando a lógica segura (Wasm-like)
            const finalAmount = calculateFinalPriceSecure(tcQuantity, BUY_PRICE_PER_25_TC);

            // NOVO FIX: Valida se o campo world TEM a classe de sucesso.
            if (!worldInput.classList.contains('text-green-600')) {
                 showMessage("O servidor não foi validado. Por favor, corrija o nome do personagem.", 'bg-red-500');
                 return;
            }

            if (!characterName || !world || !pixKeyType || !pixKey || !email || !tcQuantity || isNaN(finalAmount) || finalAmount <= 0) {
                showMessage("Por favor, preencha todos os campos corretamente.", 'bg-red-500');
                return;
            }

            const orderData = {
                userId: userId,
                userName: auth.currentUser.displayName, // NOVO: Salva o nome do usuário
                type: 'VENDA', // Tipo: Usuário vendendo para Tibex - Tibia Exchange
                characterName: sanitizeInput(characterName), // SEGURANÇA 2: Limpa input do usuário
                world: sanitizeInput(world), // SEGURANÇA 2: Limpa input do usuário
                email: sanitizeInput(email), // SEGURANÇA 2: Limpa input do usuário (já vem do Google)
                pixKeyType: sanitizeInput(pixKeyType), // SEGURANÇA 2: Limpa input do usuário
                pixKey: sanitizeInput(pixKey), // SEGURANÇA 2: Limpa input do usuário
                tcQuantity,
                finalAmount, // Valor final recalculado e seguro (ANTI-TAMPERING)
                status: 'Aguardando Transferência', // CipCoins aguarda a transferência do usuário
                // ATENÇÃO: Mudança de nome no personagem para Tibex Bank
                platformCharacter: 'Tibex Bank', 
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            };

            openOrderSummaryPopup({
                title: "Resumo da Venda",
                details: {
                    userName: auth.currentUser.displayName,
                    email: auth.currentUser.email,
                    characterName: characterName,
                    world: world,
                    tcQuantity: tcQuantity,
                    finalAmount: finalAmount
                },
                onConfirm: (confirmed) => {
                    if (confirmed) {
                        proceedWithSellOrder(orderData);
                    }
                }
            });
        }
        
        /**
         * Exibe a seção de confirmação de transferência In-Game para Venda (Sell Order)
         */
        function displaySellConfirmation(orderId, tcQuantity, platformCharacter, world, amount) {
            document.getElementById('buy-form-container').classList.add('hidden');
            document.getElementById('sell-form-container').classList.add('hidden');
            document.getElementById('pix-payment-container').classList.add('hidden');
            document.getElementById('transaction-tabs-container').classList.add('hidden'); // NOVO: Oculta as abas
            document.getElementById('sell-confirmation-container').classList.remove('hidden');

            document.getElementById('sell-conf-order-id').innerText = orderId.substring(0, 8);
            // ATENÇÃO: Mudança de cor para verde
            document.getElementById('sell-conf-amount').innerText = `R$ ${amount.toFixed(2).replace('.', ',')}`; 
            document.getElementById('sell-conf-tc-quantity').innerText = tcQuantity;
            document.getElementById('sell-conf-char-name').innerText = platformCharacter;
            document.getElementById('sell-conf-world').innerText = world;
        }

        /**
         * NOVO: Valida o tipo de entrada da chave PIX com base no tipo selecionado.
         * Permite apenas números para CPF/CNPJ e Celular.
         */
        window.handlePixKeyTypeChange = function() {
            const keyTypeSelect = document.getElementById('sell-pix-key-type');
            const pixKeyInput = document.getElementById('sell-pix-key');
            const selectedType = keyTypeSelect.value;

            // Limpa o campo ao trocar o tipo para evitar erros
            pixKeyInput.value = '';

            if (selectedType === 'CPF' || selectedType === 'CELULAR') {
                // Restringe a entrada para apenas números
                pixKeyInput.onkeypress = isNumberKey;
                pixKeyInput.placeholder = 'Apenas números';
                // Altera o tipo para 'tel' para otimizar para teclados numéricos em mobile
                pixKeyInput.type = 'tel';
            } else {
                // Permite qualquer caractere para E-mail e Aleatória
                pixKeyInput.onkeypress = null; // Remove a restrição
                pixKeyInput.placeholder = 'Chave do PIX';
                pixKeyInput.type = 'text';
            }
        }
        // NOVO: Adiciona um listener para validar o formulário ao digitar a chave PIX
        document.getElementById('sell-pix-key').addEventListener('input', () => validateAndToggleButtonState('sell'));
        document.getElementById('sell-pix-key-type').addEventListener('change', () => validateAndToggleButtonState('sell'));

        // --- RASTREIO DE PEDIDOS (REMOVIDO DO CLIENTE) ---

        /**
         * Acompanha o status de um pedido específico (Comp/Venda).
         * MANTIDO NO CÓDIGO APENAS PARA REUSO INTERNO NA FUNÇÃO showOrderHistory.
         */
        window.trackOrder = function() {
            // Lógica removida da interface do cliente
        }


        // --- LÓGICA DO PAINEL ADMIN ---

        /**
         * NOVO: Ouve as mudanças no documento de inventário.
         */
        function setupInventoryListener() {
            if (inventoryUnsubscribe) inventoryUnsubscribe(); // Limpa listener antigo
            
            const inventoryDocRef = doc(db, `artifacts/${appId}/public/data/inventory/tibia_coins`);
            
            inventoryUnsubscribe = onSnapshot(inventoryDocRef, (docSnap) => {
                const inventoryData = docSnap.exists() ? docSnap.data() : { received: 0, sent: 0 };
                
                // Renderiza o Dashboard de Estoque no Painel Admin
                renderInventoryDashboard(inventoryData);

            }, (error) => {
                console.error("Erro ao ouvir inventário:", error);
                // Renderiza com zero em caso de erro
                renderInventoryDashboard({ received: 0, sent: 0 }); 
            });
        }
        
        /**
         * NOVO: Renderiza o dashboard de estoque no painel admin.
         */
        function renderInventoryDashboard(data) {
            const received = data.received || 0;
            const sent = data.sent || 0;
            const stock = received - sent;
            
            // Formatando números com separador de milhar (apenas visual)
            const formatTC = (num) => num.toLocaleString('pt-BR');

            const dashboardHtml = `
                <div class="grid grid-cols-3 gap-4 text-center mt-4 mb-8">
                    <div class="bg-gray-700 p-3 rounded-lg shadow-md border-l-4 border-green-500">
                        <p class="text-xs text-gray-400 font-semibold uppercase">Total Recebido</p>
                        <p class="text-xl font-extrabold text-green-400">${formatTC(received)} TC</p>
                    </div>
                    <div class="bg-gray-700 p-3 rounded-lg shadow-md border-l-4 border-red-500">
                        <p class="text-xs text-gray-400 font-semibold uppercase">Total Enviado</p>
                        <p class="text-xl font-extrabold text-red-400">${formatTC(sent)} TC</p>
                    </div>
                    <div class="bg-gray-700 p-3 rounded-lg shadow-md border-l-4 border-yellow-500">
                        <p class="text-xs text-gray-400 font-semibold uppercase">Estoque Atual</p>
                        <p class="text-2xl font-extrabold ${stock >= 0 ? 'text-yellow-400' : 'text-red-500'}">${formatTC(stock)} TC</p>
                    </div>
                </div>
            `;
            document.getElementById('inventory-dashboard').innerHTML = dashboardHtml;
        }

        /**
         * FUNÇÃO DE LIMPEZA: Desativa todos os listeners globais de Admin.
         */
        function stopAdminListeners() {
            if (buyOrdersUnsubscribe) {
                buyOrdersUnsubscribe();
                buyOrdersUnsubscribe = null;
            }
            if (sellOrdersUnsubscribe) {
                sellOrdersUnsubscribe();
                sellOrdersUnsubscribe = null;
            }
            if (inventoryUnsubscribe) { // Limpa o listener de inventário
                inventoryUnsubscribe();
                inventoryUnsubscribe = null;
            }
            clearTimeout(adminRenderTimeout); // NOVO: Limpa o timeout de renderização
        }

        function setupAdminPanel() {
            setupRealTimeListeners(); // Garante que o listener global de pedidos esteja ativo
            setupInventoryListener(); // NOVO: Inicializa o listener de inventário
        }

        window.showAdminPanel = function() {
            // Se estiver logado, reseta o timer
            if (isRegisteredUser) resetInactivityTimer();

            if (!isAdmin) {
                showMessage("Acesso Negado.", 'bg-red-600');
                return;
            }
            document.getElementById('client-view').classList.add('hidden');
            document.getElementById('admin-view').classList.remove('hidden');
            document.getElementById('user-history-view').classList.add('hidden'); // Oculta histórico se estiver aberto
            
            // NOVO: Garante que o painel admin sempre abra na visualização principal,
            // escondendo a tela de resultado de rastreio se estiver aberta.
            document.getElementById('admin-track-result-view').classList.add('hidden');
            toggleAdminMainView(true);

            // NOVO: Garante que o botão de ativar som seja exibido se o áudio ainda não foi habilitado.
            const audioButton = document.getElementById('enable-audio-button');
            if (audioButton) {
                audioButton.classList.toggle('hidden', isAudioEnabled);
            }

            // NOVO: Define a aba padrão do painel (Compras)
            switchAdminTab('COMPRA'); 
        }

        window.showClientView = function() {
            // Se estiver logado, reseta o timer
            if (isRegisteredUser) resetInactivityTimer();
            
            document.getElementById('admin-view').classList.add('hidden');
            document.getElementById('client-view').classList.remove('hidden');
            document.getElementById('user-history-view').classList.add('hidden'); // Oculta histórico
            showTransactionView(); // Volta para a aba de transações (compra/venda)

            // NOVO: Garante que a visualização de resultado de rastreio do admin seja escondida
            // e a visualização principal do admin seja restaurada para a próxima vez.
            const trackResultView = document.getElementById('admin-track-result-view');
            if (trackResultView) trackResultView.classList.add('hidden');
            toggleAdminMainView(true); // Restaura a visualização principal do admin
        }

        /**
         * NOVO: Alterna a visibilidade das abas do painel de administração e força a re-renderização.
         */
        window.switchAdminTab = function(type) {
            const titleElement = document.getElementById('admin-action-title');
            const trackTitle = document.getElementById('admin-track-title'); // NOVO
            const compraTab = document.getElementById('admin-compra-tab');
            const vendaTab = document.getElementById('admin-venda-tab');
            const compraContainer = document.getElementById('admin-compra-orders-container');
            const vendaContainer = document.getElementById('admin-venda-orders-container');

            if (type === 'COMPRA') {
                trackTitle.textContent = 'Rastrear Pedido de Compra'; // NOVO
                titleElement.textContent = 'Ação: Enviar TC';
                // Ativa aba de Compra (amarela)
                compraTab.classList.add('bg-yellow-600', 'text-gray-900');
                compraTab.classList.remove('bg-gray-700', 'text-white');
                // Desativa aba de Venda (cinza)
                vendaTab.classList.add('bg-gray-700', 'text-white');
                vendaTab.classList.remove('bg-blue-600');
                // Exibe o container correto
                compraContainer.classList.remove('hidden');
                vendaContainer.classList.add('hidden');
            } else { // VENDA
                trackTitle.textContent = 'Rastrear Pedido de Venda'; // NOVO
                titleElement.textContent = 'Ação: Enviar PIX';
                // Ativa aba de Venda (azul)
                vendaTab.classList.add('bg-blue-600', 'text-white');
                vendaTab.classList.remove('bg-gray-700');
                // Desativa aba de Compra (cinza)
                compraTab.classList.add('bg-gray-700', 'text-white');
                compraTab.classList.remove('bg-yellow-600', 'text-gray-900');
                // Exibe o container correto
                vendaContainer.classList.remove('hidden');
                compraContainer.classList.add('hidden');
            }
        };

        /**
         * NOVO: Cola o texto da área de transferência no campo de rastreio do admin.
         */
        window.pasteFromClipboard = async function() {
            const orderIdInput = document.getElementById('admin-track-order-id');
            if (!navigator.clipboard) {
                showMessage("Seu navegador não suporta a função de colar.", 'bg-red-500');
                return;
            }
            try {
                const text = await navigator.clipboard.readText();
                orderIdInput.value = text.trim();
                showMessage("ID colado com sucesso!", 'bg-green-600');
                // Opcional: focar no campo após colar
                orderIdInput.focus();
            } catch (err) {
                console.error('Falha ao ler da área de transferência:', err);
                showMessage("Falha ao colar. Verifique as permissões do navegador.", 'bg-red-500');
            }
        };

        // Função auxiliar para mostrar/ocultar a visualização principal do admin
        function toggleAdminMainView(show) {
            const elementsToToggle = [
                'inventory-dashboard',
                'enable-audio-button',
                'admin-tabs-container', // CORREÇÃO: Usa o novo ID para o container das abas
                'admin-main-box',       // Usa o ID para a box principal
                // NOVO: Adiciona o parágrafo de aviso do rodapé para ser ocultado também.
                document.querySelector('p.mt-8.text-sm.text-gray-500.text-center')
            ];

            elementsToToggle.forEach(idOrEl => {
                const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
                if (el) el.classList.toggle('hidden', !show);
            });
        }

        /**
         * NOVO: Rastreia um pedido específico no painel admin.
         */
        window.trackAdminOrder = async function() {
            // Se o formulário foi submetido com Enter, previne o recarregamento da página
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
            }

             const orderIdInput = document.getElementById('admin-track-order-id');
             let orderId = orderIdInput.value.trim();
 
             if (!orderId) {
                 showMessage("Por favor, insira um ID de pedido para rastrear.", 'bg-red-500');
                 return;
             }
 
             if (orderId.startsWith('#')) {
                 orderId = orderId.substring(1);
             }
 
            const resultView = document.getElementById('admin-track-result-view');
            toggleAdminMainView(false); // Esconde a view principal do admin
            resultView.classList.remove('hidden'); // Mostra a view de resultado

             try {
                 // Função auxiliar para exibir os detalhes do pedido
                const displayOrderDetails = (orderData, type) => {
                    const details = {
                        orderId: orderId,
                        userName: sanitizeInput(orderData.userName || 'N/A'),
                        email: sanitizeInput(orderData.email || 'N/A'),
                        characterName: sanitizeInput(orderData.characterName),
                        world: sanitizeInput(orderData.world),
                        tcQuantity: orderData.tcQuantity,
                        finalAmount: orderData.finalAmount,
                        status: orderData.status,
                        createdAt: orderData.createdAt ? new Date(orderData.createdAt.seconds * 1000).toLocaleString() : 'N/A',
                        updatedAt: orderData.updatedAt ? new Date(orderData.updatedAt.seconds * 1000).toLocaleString() : 'N/A',
                        pixKey: sanitizeInput(orderData.pixKey || 'N/A'),
                        pixKeyType: sanitizeInput(orderData.pixKeyType || 'N/A'),
                        type: type
                    };

                    resultView.innerHTML = `
                        <h2 class="text-3xl font-extrabold mb-6 text-purple-400 border-b border-gray-700 pb-3">Detalhes do Pedido #${orderId.substring(0, 8)}</h2>
                        <div class="space-y-3 text-lg">
                            <p><strong>ID Completo:</strong> <span class="text-sm font-mono">${details.orderId}</span></p>
                            <p><strong>Tipo:</strong> <span class="font-bold">${details.type}</span></p>
                            <p><strong>Status:</strong> <span class="font-bold ${getStatusColor(details.status)} text-white p-1 rounded text-sm">${details.status}</span></p>
                            <hr class="border-gray-700 my-2">
                            <p><strong>Usuário:</strong> ${details.userName}</p>
                            <p><strong>Email:</strong> ${details.email}</p>
                            <hr class="border-gray-700 my-2">
                            <p><strong>Personagem:</strong> ${details.characterName}</p>
                            <p><strong>Mundo:</strong> ${details.world}</p>
                            <hr class="border-gray-700 my-2">
                            <p><strong>Tibia Coins:</strong> <span class="font-bold text-yellow-400">${details.tcQuantity} TC</span></p>
                            <p><strong>Valor:</strong> <span class="font-bold text-green-400">R$ ${details.finalAmount.toFixed(2).replace('.', ',')}</span></p>
                            ${details.type === 'VENDA' ? `<p><strong>Chave PIX:</strong> ${details.pixKeyType} - ${details.pixKey}</p>` : ''}
                            <hr class="border-gray-700 my-2">
                            <p><strong>Criado em:</strong> ${details.createdAt}</p>
                            <p><strong>Última Atualização:</strong> ${details.updatedAt}</p>
                        </div>
                     `;
                    orderIdInput.value = ''; // Limpa o campo de busca
                };
 
                 // 1. Procura na coleção de COMPRAS
                 const buyDocRef = doc(db, `artifacts/${appId}/public/data/cip_buy_orders`, orderId);
                 const buyDocSnap = await getDoc(buyDocRef);
 
                 if (buyDocSnap.exists()) {
                     displayOrderDetails(buyDocSnap.data(), 'COMPRA');
                     return; // Encontrou, então para a execução
                 }
 
                 // 2. Se não encontrou, procura na coleção de VENDAS
                 const sellDocRef = doc(db, `artifacts/${appId}/public/data/cip_sell_orders`, orderId);
                 const sellDocSnap = await getDoc(sellDocRef);
 
                 if (sellDocSnap.exists()) {
                     displayOrderDetails(sellDocSnap.data(), 'VENDA');
                     return; // Encontrou, então para a execução
                 }
 
                 // 3. Se não encontrou em nenhuma, exibe a mensagem de erro
                resultView.innerHTML = `
                    <h2 class="text-3xl font-extrabold mb-6 text-red-500 border-b border-gray-700 pb-3">Pedido Não Encontrado</h2>
                    <p class="text-lg text-gray-300">O pedido com o ID <span class="font-mono bg-gray-700 p-1 rounded">${sanitizeInput(orderId)}</span> não foi localizado em nosso sistema.</p>
                    <p class="text-gray-400 mt-4">Por favor, verifique se o ID está correto e completo e tente novamente.</p>
                `;
 
             } catch (error) {
                 console.error("Erro ao rastrear pedido:", error);
                 showMessage("Ocorreu um erro ao buscar o pedido. Verifique o console.", 'bg-red-500');
             }
         };

        // Adiciona o listener para a submissão do formulário de rastreio (Enter ou clique)
        const trackForm = document.getElementById('admin-track-form');
        if (trackForm) {
            trackForm.addEventListener('submit', window.trackAdminOrder);
        }



 // --- LÓGICA DE SOM DE NOTIFICAÇÃO (COMPATÍVEL COM MOBILE) ---

 let isAudioEnabled = false; // Controla se o áudio foi ativado pelo admin.

 /**
  * Ativa o áudio para notificações. Deve ser chamada por um evento de clique direto do usuário.
  * Esta é a única maneira confiável de habilitar o som em navegadores móveis.
  */
 window.enableNotificationSounds = function() {
     const sound = document.getElementById('notification-sound');
     if (!sound) {
         console.error("Elemento de áudio 'notification-sound' não encontrado.");
         return;
     }

     // Toca e pausa um som vazio para "acordar" o contexto de áudio do navegador.
     sound.play().then(() => {
         sound.pause();
         isAudioEnabled = true;
         console.log("Áudio para notificações ativado com sucesso.");
         showMessage("Sons de notificação ativados!", "bg-green-600");
         // Esconde o botão de ativação após o sucesso.
         document.getElementById('enable-audio-button').classList.add('hidden');
     }).catch(error => {
         console.error("Falha ao ativar o áudio:", error);
         showMessage("Seu navegador bloqueou a ativação do áudio.", "bg-red-500");
     });
 }

        /**
         * NOVO: Toca o som de notificação.
         */
        function playNotificationSound() {
            // Só toca se for admin, o painel estiver aberto E o áudio tiver sido habilitado pelo usuário.
            const adminView = document.getElementById('admin-view');
            if (!isAdmin || !isAudioEnabled || !adminView || adminView.classList.contains('hidden')) return;

            const sound = document.getElementById('notification-sound');
            if (sound) {
                // Garante que o som comece do início a cada notificação.
                sound.currentTime = 0;
                // O play() retorna uma Promise. O .catch() lida com erros de política do navegador.
                const playPromise = sound.play();
                if (playPromise !== undefined) {
                    playPromise.catch(error => console.warn("Não foi possível tocar o som de notificação:", error.message));
                }
                // Exibe o popup de notificação junto com o som.
                showMessage("Novo pedido recebido!", 'bg-red-600');

            } else {
                console.error("Elemento de áudio 'notification-sound' não encontrado.");
            }
        }

        // NOVO: Cache para os pedidos do admin, para otimizar a renderização
        let cachedBuyOrders = [];
        let cachedSellOrders = [];
        
        // NOVO: Flags para controlar a carga inicial dos listeners e evitar falsas notificações.
        let isInitialBuyLoad = true;
        let isInitialSellLoad = true;


        /**
         * Inicializa listeners para ambos os tipos de pedidos (Admin).
         */
        function setupRealTimeListeners() {
            // Garante que não haja listeners duplicados
            stopAdminListeners(); 
            setupBuyOrderListener(); 
            setupSellOrderListener(); 
        }

        function setupBuyOrderListener() { 
            if (!db) return;
            isInitialBuyLoad = true; // Reseta a flag sempre que o listener é (re)configurado
            const ordersQuery = query(collection(db, `artifacts/${appId}/public/data/cip_buy_orders`));
            
            // Atribui a função de unsubscribe
            buyOrdersUnsubscribe = onSnapshot(ordersQuery, (snapshot) => {
                // Lógica de notificação para novos pedidos
                snapshot.docChanges().forEach((change) => {
                    // Toca o som apenas se NÃO for a carga inicial e o tipo for 'added'
                    if (!isInitialBuyLoad && change.type === "added") {
                        playNotificationSound();
                    }
                });
                // Após o primeiro processamento, marca que a carga inicial foi concluída.
                isInitialBuyLoad = false;

                const buyOrders = [];
                snapshot.forEach((doc) => {
                    buyOrders.push({ id: doc.id, type: 'COMPRA', collection: 'cip_buy_orders', ...doc.data() }); 
                });
                
                // NOVO: Atualiza o cache e re-renderiza apenas se a página atual for afetada
                cachedBuyOrders = buyOrders.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
                
                // Re-renderiza a view do admin se ele estiver com o painel aberto
                // A função renderAdminOrders agora usará o cache
                if (isAdmin && !document.getElementById('admin-view').classList.contains('hidden')) {
                    renderAdminOrders();
                }
            }, (error) => { 
                // FIX CRÍTICO FINAL: Silencia o erro 'permission-denied' que é esperado
                if (error && error.code === 'permission-denied') return;
                console.error("Erro inesperado ao ouvir pedidos de COMPRA:", error); 
            renderAdminOrders(orders);
            });
        }

        function setupSellOrderListener() { 
            if (!db) return;
            isInitialSellLoad = true; // Reseta a flag sempre que o listener é (re)configurado
            const ordersQuery = query(collection(db, `artifacts/${appId}/public/data/cip_sell_orders`));
            
            // Atribui a função de unsubscribe
            sellOrdersUnsubscribe = onSnapshot(ordersQuery, (snapshot) => {
                // Lógica de notificação para novos pedidos
                snapshot.docChanges().forEach((change) => {
                    // Toca o som apenas se NÃO for a carga inicial e o tipo for 'added'
                    if (!isInitialSellLoad && change.type === "added") {
                        playNotificationSound();
                    }
                });
                // Após o primeiro processamento, marca que a carga inicial foi concluída.
                isInitialSellLoad = false;

                const sellOrders = [];
                snapshot.forEach((doc) => {
                    sellOrders.push({ id: doc.id, type: 'VENDA', collection: 'cip_sell_orders', ...doc.data() }); 
                });

                // NOVO: Atualiza o cache e re-renderiza apenas se a página atual for afetada
                cachedSellOrders = sellOrders.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

                // Re-renderiza a view do admin se ele estiver com o painel aberto
                // A função renderAdminOrders agora usará o cache
                if (isAdmin && !document.getElementById('admin-view').classList.contains('hidden')) {
                    renderAdminOrders();
                }
            }, (error) => { 
                // FIX CRÍTICO FINAL: Silencia o erro 'permission-denied' que é esperado
                if (error && error.code === 'permission-denied') return;
                console.error("Erro inesperado ao ouvir pedidos de VENDA:", error); 
            
            });
        }
        
        /**
         * FUNÇÃO: Calcula o tempo decorrido desde a criação.
         */
        function timeSince(date) {
            if (!date) return 'Agora mesmo';
            const seconds = Math.floor((new Date() - date) / 1000);

            let interval = seconds / 31536000;
            if (interval > 1) return Math.floor(interval) + " anos";
            
            interval = seconds / 2592000;
            if (interval > 1) return Math.floor(interval) + " meses";
            
            interval = seconds / 86400;
            if (interval > 1) return Math.floor(interval) + " dias";
            
            interval = seconds / 3600;
            if (interval > 1) return Math.floor(interval) + " horas";
            
            interval = seconds / 60;
            if (interval > 1) return Math.floor(interval) + " minutos";
            
            return Math.floor(seconds) + " segundos";
        }
        
        /**
         * FUNÇÃO: Retorna a cor de fundo do card com base no tipo de pedido.
         * - Verde para Compras (PIX)
         * - Azul para Vendas (TC)
         */
        function getUrgencyColor(order) { // FIX: Cor do card de Compra agora depende do status
            if (order.type === 'COMPRA') { 
                // Se o pagamento foi confirmado e aguarda sua ação, o card fica verde.
                if (order.status === 'PagoEmFila') {
                    return 'bg-green-900/30 border-l-4 border-green-500';
                }
                // Para outros status (Aguardando Pagamento, Finalizado), o card fica cinza.
                return 'bg-gray-800/30 border-l-4 border-gray-500';
            }
            
            if (order.type === 'VENDA') {
                // Se o pedido de venda já foi finalizado (PIX enviado) ou arquivado, o card fica cinza.
                if (order.status === 'PIX Enviado' || order.status === 'Arquivado') {
                    return 'bg-gray-800/30 border-l-4 border-gray-500';
                }
                // Para pedidos de venda que aguardam sua ação, o card fica azul.
                return 'bg-blue-900/30 border-l-4 border-blue-500'; 
            }
            
            return 'border-l-4 border-gray-500'; // Cor padrão de fallback.
        }
        
        /**
         * NOVO: Função auxiliar para renderizar a lista de pedidos em um container específico.
         */
        function renderAdminOrderList(container, filteredOrders, type) {
    // Limpa o timeout de renderização anterior
    clearTimeout(adminRenderTimeout);
    
    if (filteredOrders.length === 0) {
        // Mensagem de carregamento inicial
        container.innerHTML = '<p class="text-gray-400 p-4">Carregando pedidos...</p>';
        
        // Define o timeout para a mensagem de fallback (3 segundos)
        adminRenderTimeout = setTimeout(() => {
            // Verifica novamente se a lista ainda está vazia após o delay
            if (container.innerHTML.includes('Carregando pedidos')) {
                container.innerHTML = '<p class="text-yellow-400 p-4">Nenhum pedido encontrado.</p>';
            }
        }, 3000); // 3 segundos de delay para o fallback
        
        return;
    }

    // Se houver pedidos, limpa o timeout e renderiza imediatamente
    clearTimeout(adminRenderTimeout);

    const listHtml = filteredOrders.map(order => {
        const orderDate = order.createdAt ? new Date(order.createdAt.seconds * 1000) : new Date();
        const timeAgo = timeSince(orderDate);
        const isArquivado = order.status === 'Arquivado';
        const isFinalizado = order.status === 'Transferido' || order.status === 'PIX Enviado';

        // NOVO: Lógica de Status e Ações Refatorada
        let statusDisplay = { text: order.status, color: 'bg-gray-600' };
        let actionButton = '';
        let finalAmountDisplay = '';

        const finalAmountFormatted = order.finalAmount && !isNaN(order.finalAmount)
            ? order.finalAmount.toFixed(2).replace('.', ',') 
            : '0,00';

        if (order.type === 'COMPRA') {
            finalAmountDisplay = `<p class="text-white">Recebeu: <span class="font-bold text-green-400">R$ ${finalAmountFormatted}</span></p>`;
            switch (order.status) {
                case 'Aguardando Pagamento':
                    statusDisplay = { text: 'Aguardando PIX do Cliente', color: 'bg-yellow-600' };
                    break;
                case 'PagoEmFila':
                    statusDisplay = { text: 'AÇÃO: Enviar TC', color: 'bg-red-600 animate-pulse' };
                    actionButton = `<button onclick="window.openAdminConfirmModal({ title: 'Confirmar Conclusão', message: 'Deseja realmente concluir este pedido?', onConfirm: (ok) => { if (ok) updateOrderStatus('${order.id}', '${order.collection}', 'Transferido', ${order.tcQuantity}); } })" class="flex-1 bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded transition-all duration-200 shadow-md">Concluir (Enviar TC)</button>`;
                    break;
                case 'Transferido':
                    statusDisplay = { text: 'Finalizado (TC Enviado)', color: 'bg-purple-600' };
                    break;
            }
        } else if (order.type === 'VENDA') {
            finalAmountDisplay = `<p class="text-white">Pagar PIX: <span class="font-bold text-lg text-red-400">R$ ${finalAmountFormatted}</span></p>`;
            switch (order.status) {
                case 'Aguardando Transferência':
                    statusDisplay = { text: 'AÇÃO: Enviar PIX', color: 'bg-red-600 animate-pulse' };
                    actionButton = `<button onclick="window.openAdminConfirmModal({ title: 'Confirmar Conclusão', message: 'Deseja realmente concluir este pedido?', onConfirm: (ok) => { if (ok) updateOrderStatus('${order.id}', '${order.collection}', 'PIX Enviado', ${order.tcQuantity}); } })" class="flex-1 bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded transition-all duration-200 shadow-md">Concluir (Enviar PIX)</button>`;
                    break;
                case 'PIX Enviado':
                    statusDisplay = { text: 'Finalizado (PIX Enviado)', color: 'bg-purple-600' };
                    break;
            }
        }

        if (order.status === 'Arquivado') statusDisplay = { text: 'Arquivado', color: 'bg-gray-500' };

        // SEGURANÇA: Sanitizando dados antes de renderizar no Admin Panel (XSS Prevention)
        const safeOrderId = sanitizeInput(order.id.substring(0, 8));
        const safeCharacterName = sanitizeInput(order.characterName);
        const safeWorld = sanitizeInput(order.world);
        const safeTCQuantity = sanitizeInput(order.tcQuantity);
        const safePixKey = order.type === 'VENDA' ? sanitizeInput(order.pixKey) : '';
        const safeUserName = sanitizeInput(order.userName || 'Nome não disponível'); // NOVO
        const safeUserEmail = sanitizeInput(order.email || 'E-mail não disponível'); // NOVO
        const safePixKeyType = order.type === 'VENDA' ? sanitizeInput(order.pixKeyType) : '';
        
        return `
            <div class="p-4 mb-3 rounded-lg shadow-md bg-stone-900/50 ${getUrgencyColor(order)}">
                <div class="flex justify-between items-start mb-2">
                    <div>
                        <span class="text-xs font-semibold p-1 rounded ${order.type === 'COMPRA' ? 'bg-purple-500 text-white' : 'bg-blue-500 text-white'}">${order.type}</span>
                        <span class="text-xs font-bold text-gray-300 ml-2">há ${timeAgo}</span>
                    </div>
                    <p class="text-sm text-gray-400 text-right">${orderDate.toLocaleString()}</p>
                </div>
                
                <div class="mt-2 mb-3">
                    <p class="text-xs text-gray-400">ID do Pedido:</p>
                    <p class="text-sm font-mono text-yellow-300 break-all flex items-center">
                        <span>${order.id}</span>
                        <button onclick="copyToClipboard('${order.id}', 'ID Completo Copiado!')" 
                                title="Copiar ID Completo"
                                class="text-yellow-400 hover:text-yellow-300 transition-colors p-1 rounded bg-gray-700 hover:bg-gray-600 ml-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                        </button>
                    </p>
                </div>

                <!-- NOVO: Informações do Usuário -->
                <div class="bg-gray-900/50 p-2 rounded-lg mb-3 text-sm">
                    <p class="text-white">Usuário: <span class="font-bold">${safeUserName}</span></p>
                    <p class="text-gray-400">E-mail: <span class="font-semibold">${safeUserEmail}</span></p>
                </div>

                <!-- NOME DO PERSONAGEM COM BOTÃO DE COPIAR -->
                <div class="mb-2">
                    <p class="text-white flex items-center space-x-2">
                        <span class="text-sm text-gray-400">Char:</span>
                        <span id="char-name-${safeOrderId}" class="font-extrabold text-white">${safeCharacterName}</span>
                        <button onclick="copyToClipboard('${safeCharacterName}', 'Nome Copiado!')" 
                                class="text-yellow-400 hover:text-yellow-300 transition-colors p-1 rounded">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2m-9 0V3a2 2 0 012-2h4a2 2 0 012 2v2M9 5h6"></path>
                            </svg>
                        </button>
                    </p>
                    <p class="text-white">World: <span class="font-semibold">${safeWorld}</span></p>
                </div>
                
                <p class="text-white">Coins: <span class="font-bold text-lg">${safeTCQuantity} TC</span></p>
                ${finalAmountDisplay}
                ${order.type === 'VENDA' ? `
                    <div class="text-white text-sm mt-1 flex items-center space-x-2">
                        <span>PIX: ${safePixKeyType} - ${safePixKey}</span>
                        <button onclick="copyToClipboard('${safePixKey}', 'Chave PIX Copiada!')" 
                                class="text-yellow-400 hover:text-yellow-300 transition-colors p-1 rounded">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2m-9 0V3a2 2 0 012-2h4a2 2 0 012 2v2M9 5h6"></path>
                            </svg>
                        </button>
                    </div>
                ` : ''}

                <p class="mt-3 text-sm">Status: <span class="font-bold text-xs p-1 rounded ${statusDisplay.color}">${statusDisplay.text}</span></p>

                <div class="mt-4 flex space-x-2">
                    ${actionButton}
                    ${!isFinalizado && !isArquivado ? `
                        <button onclick="window.openAdminConfirmModal({
                            title: 'Confirmar Arquivar Pedido',
                            message: 'Deseja realmente arquivar este pedido?',
                            onConfirm: (ok) => { if (ok) updateOrderStatus('${order.id}', '${order.collection}', 'Arquivado'); }
                        })"
                            class="bg-red-800 hover:bg-red-700 text-white font-bold py-2 px-4 rounded transition-all duration-200 shadow-md">
                            Arquivar
                        </button>` : ''}
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = listHtml;
}

let currentPageBuy = 1;  // Página atual de compras
let currentPageSell = 1; // Página atual de vendas
const itemsPerPage = 4;  // Quantidade de pedidos por página

function changePage(type, page) {
    if (type === 'COMPRA') {
        currentPageBuy = page;
    } else if (type === 'VENDA') {
        currentPageSell = page;
    }
    renderAdminOrders(); // A função agora usa o cache interno
}

window.changePage = changePage;

function paginate(orders, type) { // A função paginate continua a mesma
    const currentPage = type === 'COMPRA' ? currentPageBuy : currentPageSell;
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return orders.slice(startIndex, endIndex);
}

function renderAdminOrders() {
    const buyContainer = document.getElementById('admin-compra-orders-list');
    const sellContainer = document.getElementById('admin-venda-orders-list');

    // A função agora usa os caches que já estão filtrados e ordenados

    // Aplica a paginação nos pedidos
    const paginatedBuyOrders = paginate(cachedBuyOrders, 'COMPRA');
    const paginatedSellOrders = paginate(cachedSellOrders, 'VENDA');

    // Renderiza as listas de pedidos
    renderAdminOrderList(buyContainer, paginatedBuyOrders, 'COMPRA');
    renderAdminOrderList(sellContainer, paginatedSellOrders, 'VENDA');

    // Renderiza os botões de navegação
    renderPagination(cachedBuyOrders.length, cachedSellOrders.length);
}

function renderPagination(buyOrdersCount, sellOrdersCount) {
    const totalPagesBuy = Math.ceil(buyOrdersCount / itemsPerPage);
    const totalPagesSell = Math.ceil(sellOrdersCount / itemsPerPage);

    // Compra
    const paginationCompra = document.getElementById('pagination-container-compra');
    if (paginationCompra) {
        paginationCompra.innerHTML = '';
        if (totalPagesBuy > 1) {
            paginationCompra.innerHTML = `
                <div class="pagination mb-2">
                    ${currentPageBuy > 1 ? `<button onclick="changePage('COMPRA', ${currentPageBuy - 1})">Anterior</button>` : ''}
                    <span>Página ${currentPageBuy} de ${totalPagesBuy} (Compras)</span>
                    ${currentPageBuy < totalPagesBuy ? `<button onclick="changePage('COMPRA', ${currentPageBuy + 1})">Próxima</button>` : ''}
                </div>
            `;
        }
    }

    // Venda
    const paginationVenda = document.getElementById('pagination-container-venda');
    if (paginationVenda) {
        paginationVenda.innerHTML = '';
        if (totalPagesSell > 1) {
            paginationVenda.innerHTML = `
                <div class="pagination">
                    ${currentPageSell > 1 ? `<button onclick="changePage('VENDA', ${currentPageSell - 1})">Anterior</button>` : ''}
                    <span>Página ${currentPageSell} de ${totalPagesSell} (Vendas)</span>
                    ${currentPageSell < totalPagesSell ? `<button onclick="changePage('VENDA', ${currentPageSell + 1})">Próxima</button>` : ''}
                </div>
            `;
        }
    }
}

      
        /**
         * Atualiza o status de um pedido no Firestore.
         * NOVO: Agora inclui a lógica de atualização de inventário.
         */
        window.updateOrderStatus = async function(orderId, collectionName, newStatus, tcQuantity) {
            // Se estiver logado, reseta o timer
            if (isRegisteredUser) resetInactivityTimer();
            
            if (!isAdmin) {
                showMessage("Ação não autorizada.", 'bg-red-600');
                return;
            }
            
            // 1. Definições da transação de estoque
            let tcChange = 0;
            let fieldToUpdate = ''; // 'received' (venda) ou 'sent' (compra)
            
            const isBuyOrder = collectionName.includes('cip_buy_orders');
            const isSellOrder = collectionName.includes('cip_sell_orders');
            
            const inventoryDocRef = doc(db, `artifacts/${appId}/public/data/inventory/tibia_coins`);

            // 2. Lógica de atualização de inventário (APENAS se for o status FINAL de entrega)
            if (newStatus === 'Transferido' && isBuyOrder) {
                // COMPRA (Usuário pagou, você ENVIARÁ TC) -> Diminui o estoque
                tcChange = tcQuantity;
                fieldToUpdate = 'sent';
            } else if (newStatus === 'PIX Enviado' && isSellOrder) {
                // VENDA (Usuário enviou TC, você enviará PIX) -> Aumenta o estoque
                tcChange = tcQuantity;
                fieldToUpdate = 'received';
            }

            try {
                // A) Atualiza o Status do Pedido
                const docRef = doc(db, `artifacts/${appId}/public/data/${collectionName}`, orderId);
                await updateDoc(docRef, {
                    status: newStatus,
                    updatedAt: serverTimestamp(),
                    processedBy: userId
                });

                // B) Atualiza o Inventário (apenas se houve uma mudança de estoque)
                if (tcChange > 0 && fieldToUpdate) {
                    await setDoc(inventoryDocRef, {
                        [fieldToUpdate]: increment(tcChange), // Incrementa o campo 'received' ou 'sent'
                        updatedAt: serverTimestamp()
                    }, { merge: true });
                    showMessage(`Estoque de TC atualizado: +${tcChange} em ${fieldToUpdate}!`, 'bg-green-700');
                }

                // Mensagem de sucesso
                showMessage(`Pedido #${orderId.substring(0, 8)} atualizado para: ${newStatus}`, 'bg-purple-500');

            } catch (error) {
                console.error("Erro ao atualizar status ou inventário:", error);
                showMessage("Erro ao salvar status. Verifique o console.", 'bg-red-500');
            }
        }

        /**
         * NOVO: Filtra a entrada de caracteres (apenas números).
         */
        window.isNumberKey = function(evt) {
            const charCode = (evt.which) ? evt.which : evt.keyCode;
            // Permite 0-9 e controle de teclas (backspace, delete, etc.)
            if (charCode > 31 && (charCode < 48 || charCode > 57)) {
                return false;
            }
            return true;
        }

        // --- Funções de Utilidade ---
        
        /**
         * NOVA FUNÇÃO: Copia o texto para a área de transferência.
         */
        window.copyToClipboard = function(text, successMessage) {
            // Usamos document.execCommand('copy') como fallback para garantir compatibilidade em iframes.
            if (!navigator.clipboard) {
                const tempInput = document.createElement('textarea');
                tempInput.value = text;
                document.body.appendChild(tempInput);
                tempInput.select();
                document.execCommand('copy');
                document.body.removeChild(tempInput);
                showMessage(successMessage || 'Copiado para a área de transferência! (Fallback)', 'bg-green-600');
                return;
            }
            
            navigator.clipboard.writeText(text).then(() => {
                showMessage(successMessage || 'Copiado para a área de transferência!', 'bg-green-600');
            }).catch(err => {
                console.error('Falha ao copiar:', err);
                showMessage('Falha ao copiar. Tente manualmente.', 'bg-red-500');
            });
        }
        
        /**
         * Exibe um modal.
         */
        window.showModal = function(modalId) {
            document.getElementById(modalId).classList.remove('hidden');
            document.body.classList.add('overflow-hidden'); // BLOQUEIA O SCROLL no body
            document.documentElement.classList.add('overflow-hidden'); // FIX IOS: BLOQUEIA O SCROLL no HTML
        }

        /**
         * Esconde um modal.
         */
        window.hideModal = function(modalId) {
            document.getElementById(modalId).classList.add('hidden');
            document.body.classList.remove('overflow-hidden'); // LIBERA O SCROLL
            document.documentElement.classList.remove('overflow-hidden'); // FIX IOS: LIBERA O SCROLL no HTML
        }
        
        /**
         * Esconde todos os modais.
         */
        function hideAllModals() {
            document.getElementById('google-login-modal').classList.add('hidden');
            document.body.classList.remove('overflow-hidden'); // LIBERA O SCROLL
            document.documentElement.classList.remove('overflow-hidden'); // FIX IOS: LIBERA O SCROLL no HTML
        }

        /**
         * Atualiza o resumo de preços no cabeçalho.
         */
        window.updatePriceSummary = function() {
            const summaryElement = document.getElementById('price-summary');
            if (summaryElement) {
                const sellPrice = SELL_PRICE_PER_25_TC.toFixed(2).replace('.', ',');
                const buyPrice = BUY_PRICE_PER_25_TC.toFixed(2).replace('.', ',');
                // APLICAÇÃO DA QUEBRA DE LINHA AQUI
                summaryElement.innerHTML = `Compre TC a R$ ${sellPrice} / 25 TC <br> Venda TC a R$ ${buyPrice} / 25 TC`;
            }
        };

        /**
         * Fecha a caixa de mensagens flutuante.
         */
        window.closeMessage = function() {
            const messageBox = document.getElementById('message-box');
            messageBox.classList.add('opacity-0');
            setTimeout(() => messageBox.classList.add('hidden'), 300);
        }

        /**
         * Exibe mensagens temporárias ao usuário.
         */
        function showMessage(msg, bgColor) {
            const messageBox = document.getElementById('message-box');
            
            // Conteúdo da mensagem com botão de fechar
            messageBox.innerHTML = `
                <div class="message-box-content flex items-center justify-between space-x-4 p-3 pr-10">
                    <p class="text-white">${msg}</p>
                    <button onclick="closeMessage()" class="absolute right-2 top-1/2 transform -translate-y-1/2 text-white/80 hover:text-white transition-colors p-1 rounded-full">
                        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"></path></svg>
                    </button>
                </div>
            `;
            
            messageBox.className = `fixed top-4 left-1/2 transform -translate-x-1/2 z-50 rounded-xl shadow-lg transition-all duration-300 opacity-0 ${bgColor}`;
            messageBox.classList.remove('opacity-0', 'hidden');

            // Timeout para auto-fechar (pode ser cancelado se o usuário clicar no 'X')
            setTimeout(() => {
                closeMessage();
            }, 5000);
        }

        /**
         * NOVO: Função para fechar o dropdown de perfil.
         */
        window.closeAuthMenuDropdown = function() { // FIX: Declarado globalmente (window.) para evitar SyntaxError
            document.getElementById('auth-menu').classList.add('hidden');
        }
        
        // --- WebAssembly Initialization ---
        // Funções para gerenciar o módulo Wasm (Emscripten)
        
        // Define a função de inicialização do Emscripten
        Module.onRuntimeInitialized = function() {
            wasmReady = true;
            console.log("WebAssembly Module (Price Calculator) loaded successfully.");
            // Recarrega os preços para usar a função Wasm
            window.calculateBuyPrice();
            window.calculateSellPrice();
        };

        // Inicia o aplicativo
        initializeFirebase();
        
        // NOVO: Adiciona listeners globais para monitorar a inatividade (apenas no cliente logado)
        document.addEventListener('mousemove', resetInactivityTimer);
        document.addEventListener('keydown', resetInactivityTimer);
        document.addEventListener('touchstart', resetInactivityTimer);

        // NOVO: Listener para fechar o dropdown ao rolar a página (scroll)
        document.addEventListener('scroll', closeAuthMenuDropdown);


        /**
         * NOVO: Fecha o dropdown de perfil e o modal de login quando clica fora.
         */
        document.addEventListener('click', (event) => {
            const authMenu = document.getElementById('auth-menu');
            const userIcon = document.getElementById('user-icon');
            const googleModal = document.getElementById('google-login-modal');
            const target = event.target;

            // Lógica para fechar o Dropdown (Auth Menu)
            // Se o menu estiver visível E o clique não foi no ícone NEM dentro do menu...
            if (!authMenu.classList.contains('hidden') && !userIcon.contains(target) && !authMenu.contains(target)) {
                closeAuthMenuDropdown(); // Chama a função globalmente declarada
            }

            // Lógica para fechar o Modal (clicar no overlay escuro)
            // Se o modal estiver visível E o clique foi exatamente no overlay (o modal container)
            if (!googleModal.classList.contains('hidden') && target === googleModal) {
                // Ao fechar o modal, precisamos liberar o scroll
                document.body.classList.remove('overflow-hidden');
                document.documentElement.classList.remove('overflow-hidden'); // FIX IOS
                googleModal.classList.add('hidden');
            }
        });


        // Inicializa o cálculo do preço ao carregar - Movido para dentro do módulo
        window.onload = function() {
            // Define o valor inicial dos campos antes de calcular
            document.getElementById('buy-tc-quantity').value = MIN_TC_QUANTITY;
            document.getElementById('sell-tc-quantity').value = MIN_TC_QUANTITY;
            
            window.calculateBuyPrice();
            window.calculateSellPrice();
            window.handlePixKeyTypeChange(); // NOVO: Define o estado inicial do campo de chave PIX
            window.switchTab('buy-tab'); // Inicia na aba de Compra
            window.updatePriceSummary(); // Adicionado para exibir a cotação no cabeçalho
        };
        
        