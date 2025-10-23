import { useState, useRef, useEffect } from 'react';
import { User } from 'lucide-react';
import { collection, getDocs, addDoc, query, where, orderBy, Timestamp, doc, updateDoc, writeBatch } from "firebase/firestore";
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { db, auth } from './firebaseConfig'; // Importa a instância do Firestore e Auth
import { Copy } from 'lucide-react';
// Tipagem para o objeto do usuário logado (Firebase Auth User)
interface AppUser {
  uid: string; // Firebase Auth User ID
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
}

// Tipagem para os pedidos de exemplo
interface Order {
  id?: string; // O ID do documento do Firestore será opcional ao criar, mas presente ao ler
  userId: string; // ID do usuário que fez o pedido
  userDisplayName: string | null; // Nome do usuário
  userEmail: string | null; // Email do usuário
  type: 'compra' | 'venda';
  date: string;
  charName: string;
  world: string;
  quantity: number;
  value: string;
  status: 'Concluído' | 'Pendente' | 'Cancelado' | 'Expirado' | 'Pago';
  createdAt: Timestamp; // Usar Timestamp do Firestore
  pixKey?: string; // Chave PIX para pedidos de venda
  keyType?: string; // Tipo da chave PIX
}

// --- Constantes de Configuração ---
const ADMIN_UID = 'cAB72OOZXfgffWXh8Kbyxoo3cFo1'; // UID do usuário administrador

// --- PREÇOS DE TRANSAÇÃO ---
const BUY_PRICE_PER_25_TC = 5.97; // Valor de COMPRA para cada 25 TC em R$
const SELL_PRICE_PER_25_TC = 4.80; // Valor de VENDA para cada 25 TC em R$

// --- Componente Avatar ---
const getInitials = (displayName: string | null): string => {
  if (!displayName) {
    return '??';
  }
  const names = displayName.trim().split(' ').filter(Boolean);
  if (names.length > 1) {
    return `${names[0][0]}${names[names.length - 1][0]}`.toUpperCase();
  }
  if (names.length === 1 && names[0].length > 1) {
    return names[0].substring(0, 2).toUpperCase();
  }
  if (names.length === 1) {
    return names[0].substring(0, 1).toUpperCase();
  }
  return '??';
};

const Avatar = ({ user }: { user: AppUser }) => {
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setImageError(false); // Reseta o erro quando o usuário muda
  }, [user.photoURL]);

  if (user.photoURL && !imageError) {
    return (
      <img src={user.photoURL} alt={user.displayName || 'User'} className="w-full h-full object-cover" onError={() => setImageError(true)} />
    );
  }

  const initials = getInitials(user.displayName);
  return <span className="font-bold text-lg text-yellow-400">{initials}</span>;
};

export default function TibexExchange() {
  // Estados de visualização e formulário
  const [currentView, setCurrentView] = useState<'exchange' | 'dashboard'>('exchange');
  const [activeTab, setActiveTab] = useState('comprar');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [quantity, setQuantity] = useState<number | ''>(25);  
  // Controle das etapas do processo de compra (0 = formulário, 1-4 = etapas)
  const [purchaseStep, setPurchaseStep] = useState(0);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(5); // 5 segundos para o contador

  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const paymentSucceededRef = useRef(false);
  // Estados do painel de histórico
  const [historyFilter, setHistoryFilter] = useState<'todas' | 'compras' | 'vendas' | 'pago'>('todas');
  const [currentPage, setCurrentPage] = useState(1);
  const [orders, setOrders] = useState<Order[]>([]); // Estado para armazenar os pedidos do Firestore
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  // Estados para as métricas do admin
  const [totalCoinsReceived, setTotalCoinsReceived] = useState(0);
  const [totalCoinsSent, setTotalCoinsSent] = useState(0);
  const [currentStock, setCurrentStock] = useState(0);

  // Garante que quantity seja um número para o cálculo, mesmo que seja ''
  const numericQuantity = typeof quantity === 'number' ? quantity : 0;
  const totalValue = activeTab === 'comprar'
    ? ((numericQuantity / 25) * BUY_PRICE_PER_25_TC).toFixed(2)
    : ((numericQuantity / 25) * SELL_PRICE_PER_25_TC).toFixed(2);

  // Estado para armazenar os dados do usuário logado
  const [loggedInUser, setLoggedInUser] = useState<AppUser | null>(null);
  const [charName, setCharName] = useState('');
  const [world, setWorld] = useState('');
  const [email, setEmail] = useState('');
  const [keyType, setKeyType] = useState('CPF/CNPJ');
  const [pixKey, setPixKey] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Estado para carregamento dos pedidos
  const [isLoadingOrders, setIsLoadingOrders] = useState(true);

  // Estados para busca de personagem na API TibiaData
  const [isFetchingChar, setIsFetchingChar] = useState(false);
  const [charError, setCharError] = useState<string | null>(null);
  const [charLevel, setCharLevel] = useState<number | null>(null);

  // Efeito para monitorar o estado de autenticação do Firebase
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        // Usuário está logado
        const appUser: AppUser = {
          uid: user.uid,
          displayName: user.displayName,
          email: user.email,
          photoURL: user.photoURL,
        };
        setLoggedInUser(appUser);
        setEmail(user.email || ''); // Preenche o e-mail automaticamente
        setCurrentPage(1); // Reseta a paginação
        setCurrentView('exchange'); // Volta para a tela de troca
      } else {
        // Usuário deslogado
        setLoggedInUser(null);
        setEmail('');
        setOrders([]); // Limpa os pedidos
        setIsDropdownOpen(false);
        setCurrentView('exchange'); // Volta para a tela principal
      }
      setIsLoadingOrders(false); // Finaliza o carregamento inicial
    });

    // Limpa a inscrição ao desmontar o componente
    return () => unsubscribe();
  }, []);

  // Função para acionar o pop-up de login do Google
  const handleGoogleLogin = async () => {
    const provider = new GoogleAuthProvider();
    setIsDropdownOpen(false); // Fecha o dropdown imediatamente
    try {
      await signInWithPopup(auth, provider);
      // onAuthStateChanged irá lidar com a atualização do loggedInUser
    } catch (error: any) {
      // Verifica se o erro foi o usuário fechando o pop-up
      if (error.code === 'auth/cancelled-popup-request' || error.code === 'auth/popup-closed-by-user') {
        console.log("Login cancelado pelo usuário.");
      } else {
        // Para todos os outros erros, exibe o alerta
        console.error("Erro ao fazer login com Google:", error);
        alert(`Erro ao fazer login: ${error.message}`);
      }
    }
  };

  // Função de Logout
  const handleLogout = async () => {
    // Agora, o logout sempre desloga o usuário do Firebase.
    try {
      await signOut(auth);
      // onAuthStateChanged irá lidar com a limpeza do resto do estado.
      setIsDropdownOpen(false);
    } catch (error) {
      console.error("Erro ao fazer logout:", error);
      alert("Erro ao fazer logout. Tente novamente.");
    }
  };

  // Efeito para fechar o dropdown ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }

    // Adiciona o listener quando o dropdown está aberto
    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    // Remove o listener ao limpar o efeito
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isDropdownOpen]);

  // Efeito para buscar o mundo do personagem com debounce
  useEffect(() => {
    // Se o nome do char for muito curto ou vazio, limpa o campo world e o erro.
    if (charName.trim().length < 3) {
      setWorld('');
      setCharError(null);
      setCharLevel(null);
      return;
    }

    const fetchCharacterData = async () => {
      setIsFetchingChar(true);
      setCharError(null);
      try {
        const response = await fetch(`https://api.tibiadata.com/v4/character/${encodeURIComponent(charName.trim())}`);
        const data = await response.json();

        if (response.ok && data.character && data.character.character) {
          setWorld(data.character.character.world);
          setCharLevel(data.character.character.level);
        } else {
          setWorld(''); // Limpa o mundo se o personagem não for encontrado
          setCharError('Personagem não encontrado.');
          setCharLevel(null);
        }
      } catch (error) {
        setWorld('');
        setCharError('Erro ao buscar dados do personagem.');
        setCharLevel(null);
        console.error("Erro na API TibiaData:", error);
      } finally {
        setIsFetchingChar(false);
      }
    };

    const timerId = setTimeout(fetchCharacterData, 500); // Aguarda 500ms após o usuário parar de digitar
    return () => clearTimeout(timerId); // Limpa o timeout se o usuário digitar novamente
  }, [charName]); // Este efeito é executado sempre que 'charName' muda

  // Efeito para carregar os pedidos do Firestore quando o usuário loga ou muda
  useEffect(() => {
    const fetchOrders = async () => {
      if (!loggedInUser) {
        setOrders([]);
        setIsLoadingOrders(false);
        return;
      }

      setIsLoadingOrders(true);
      try {
        // Verifica se o usuário logado é o administrador
        const isAdmin = loggedInUser.uid === ADMIN_UID;

        let ordersQuery;

        if (isAdmin) {
          // Se for admin, busca todos os pedidos, ordenados por data
          ordersQuery = query(collection(db, "orders"), orderBy("createdAt", "desc"));
        } else {
          // Se não for admin, busca apenas os pedidos do próprio usuário
          ordersQuery = query(
            collection(db, "orders"),
            where("userId", "==", loggedInUser.uid),
            orderBy("createdAt", "desc")
          );
        }
        const querySnapshot = await getDocs(ordersQuery);
        const fetchedOrders: Order[] = querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data() as Omit<Order, 'id'> // Converte os dados do documento para o tipo Order
        }));
        setOrders(fetchedOrders);
      } catch (error) {
        console.error("Erro ao buscar pedidos:", error);
        alert("Erro ao carregar seus pedidos. Tente novamente.");
      }
      setIsLoadingOrders(false);
    };

    fetchOrders();
  }, [loggedInUser]); // Depende do loggedInUser

  // Efeito para calcular as métricas do admin
  useEffect(() => {
    if (loggedInUser?.uid === ADMIN_UID) {
      const received = orders
        .filter(order => order.type === 'compra' && order.status === 'Pago')
        .reduce((sum, order) => sum + order.quantity, 0);

      const sent = orders
        .filter(order => order.type === 'venda' && order.status === 'Concluído')
        .reduce((sum, order) => sum + order.quantity, 0);

      setTotalCoinsReceived(received);
      setTotalCoinsSent(sent);
      setCurrentStock(received - sent);
    }
  }, [orders, loggedInUser]); // Recalcula quando os pedidos ou o usuário mudam

  const handleSubmit = async () => {
    if (!loggedInUser) {
      alert("Sessão expirada. Por favor, faça login novamente.");
      handleLogout();
      return;
    }

    // Validação básica
    if (!charName || !world || (activeTab === 'vender' && !pixKey)) {
      alert('Por favor, preencha todos os campos obrigatórios!');
      // Volta para o formulário caso haja algum problema
      setPurchaseStep(0);
      return;
    }

    const newOrder: Omit<Order, 'id' | 'pixKey' | 'keyType'> & { pixKey?: string; keyType?: string } = {
      userId: loggedInUser.uid, // Usar o UID do Firebase Auth
      userDisplayName: loggedInUser.displayName,
      userEmail: loggedInUser.email,
      type: activeTab === 'comprar' ? 'compra' : 'venda',
      date: new Date().toLocaleDateString('pt-BR'), // Formato DD/MM/YYYY
      charName,
      world,
      quantity: quantity as number, // Agora é seguro fazer o cast, pois isSubmitDisabled garante que é um número >= 25
      value: totalValue,
      status: 'Pendente',
      createdAt: Timestamp.now(), // Usar Timestamp do Firestore
    };

    if (activeTab === 'vender') {
      newOrder.pixKey = pixKey;
      newOrder.keyType = keyType;
    }

    try {
      const docRef = await addDoc(collection(db, "orders"), newOrder);
      // Atualiza a lista de pedidos localmente ou refetch
      setOrders(prevOrders => [{ ...newOrder, id: docRef.id } as Order, ...prevOrders]);
      // Avança para a etapa de pagamento e guarda o ID do pedido
      setPendingOrderId(docRef.id);
      setPurchaseStep(4);
    } catch (e) {
      console.error("Erro ao adicionar documento: ", e);
      alert("Erro ao enviar o pedido. Tente novamente.");
    }
  };

  // Função para copiar texto para a área de transferência
  const handleCopy = (text: string, entityName: string = 'Texto') => {
    navigator.clipboard.writeText(text).then(() => {
      alert(`${entityName} copiado!`);
    }).catch(err => {
      console.error(`Erro ao copiar ${entityName}: `, err);
      alert(`Não foi possível copiar o texto.`);
    });
  };

  // Função para alternar a expansão de um pedido
  const handleOrderToggle = (orderId: string) => {
    setExpandedOrderId(prevId => (prevId === orderId ? null : orderId));
  };
  // Lógica de Filtragem e Paginação para o Histórico
  const filteredOrders = orders.filter(order => { // Usa o estado 'orders'
    if (historyFilter === 'todas') return true;
    if (historyFilter === 'compras') return order.type === 'compra';
    if (historyFilter === 'pago') return order.status === 'Pago';
    if (historyFilter === 'vendas') return order.type === 'venda';
    return false;
  });
  const ordersPerPage = 4;
  const totalPages = Math.ceil(filteredOrders.length / ordersPerPage);
  const indexOfLastOrder = currentPage * ordersPerPage;
  const indexOfFirstOrder = indexOfLastOrder - ordersPerPage;
  // Garante que currentOrders seja sempre um array, mesmo que filteredOrders esteja vazio
  const currentOrders = filteredOrders.slice(indexOfFirstOrder, indexOfLastOrder);

  // Lógica para desabilitar o botão de submit
  const isSubmitDisabled =
    !loggedInUser ||
    !charName.trim() ||
    !world || // Mundo não encontrado (implica que charName é válido e encontrado)
    isFetchingChar ||
    !!charError ||
    (typeof quantity !== 'number' || isNaN(quantity as number) || (quantity as number) < 25) || // Adiciona verificação para quantity
    (activeTab === 'vender' && !pixKey.trim());

  const isConfirmationDisabled = !termsAccepted;

  // Desabilita a navegação para fora do fluxo de compra
  const isDuringPurchase = purchaseStep > 0;

  // Função para resetar os campos do formulário
  const resetForm = () => {
    setQuantity(25);
    setCharName('');
    setWorld('');
    setCharError(null);
    setPixKey('');
    setCharLevel(null);
    setKeyType('CPF/CNPJ');
    setPurchaseStep(0); // Garante que sempre volte para o formulário
    setTermsAccepted(false);
    setPendingOrderId(null);
    paymentSucceededRef.current = false; // Reseta a referência de pagamento
  };

  // Função para validar e arredondar a quantidade ao sair do campo
  const handleQuantityBlur = () => {
    const currentQuantity = typeof quantity === 'string' && quantity !== '' ? parseInt(quantity, 10) : quantity;

    if (typeof currentQuantity !== 'number' || isNaN(currentQuantity) || currentQuantity < 25) {
      setQuantity(25);
      return;
    }

    // Arredonda para o múltiplo de 25 mais próximo
    const roundedValue = Math.round(currentQuantity / 25) * 25;
    setQuantity(Math.max(25, roundedValue));
  };
  // Função para validar a Chave PIX
  const handlePixKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { value } = e.target;

    if (keyType === 'CPF/CNPJ' || keyType === 'Telefone') {
      // Remove caracteres não numéricos e limita o comprimento
      const numericValue = value.replace(/\D/g, '');
      setPixKey(numericValue.slice(0, 15));
    } else {
      // Permite qualquer caractere para outros tipos de chave
      setPixKey(value);
    }
  };

  // Função para lidar com a mudança do tipo de chave PIX
  const handleKeyTypeSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setKeyType(e.target.value);
    setPixKey(''); // Reseta o campo da chave PIX para evitar dados inválidos
  };

  // Função para simular a confirmação de pagamento (para testes)
  const handleSimulatePayment = async () => {
    if (!pendingOrderId) return;
    paymentSucceededRef.current = true; // Sinaliza que o pagamento foi bem-sucedido
    // 1. Limpa o intervalo do contador imediatamente para evitar a expiração.
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
    }

    const orderDocRef = doc(db, "orders", pendingOrderId);
    try {
      await updateDoc(orderDocRef, { status: "Pago" });
      setOrders(prevOrders =>
        prevOrders.map(o => (o.id === pendingOrderId ? { ...o, status: 'Pago' } : o))
      );
      setPurchaseStep(6);
    } catch (error) {
      console.error("Erro ao simular pagamento: ", error);
      alert("Não foi possível confirmar o pagamento.");
    }
  };
  // Função para forçar a primeira letra do nome do char a ser maiúscula
  const handleCharNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value.length > 0) {
      setCharName(value.charAt(0).toUpperCase() + value.slice(1));
    } else {
      setCharName('');
    }
  };

  // Função para o admin marcar um pedido como "Concluído"
  const handleCompleteOrder = async (orderId: string) => {
    if (!window.confirm('Tem certeza que deseja marcar este pedido como "Concluído"? Esta ação não pode ser desfeita.')) {
      return;
    }

    // 1. Inicia um "lote" de escritas
    const batch = writeBatch(db);

    try {
      // 2. Define a primeira operação: atualizar o status do pedido
      const orderDocRef = doc(db, "orders", orderId);
      batch.update(orderDocRef, { status: 'Concluído' });

      // (Opcional) Exemplo: Atualizar um contador no perfil do usuário
      // const order = orders.find(o => o.id === orderId);
      // if (order) {
      //   const userProfileRef = doc(db, "users", order.userId);
      //   batch.update(userProfileRef, { completedOrders: increment(1) });
      // }

      // 3. Executa todas as operações do lote de uma vez
      await batch.commit();

      // Atualiza o estado local para refletir a mudança imediatamente
      setOrders(prevOrders => 
        prevOrders.map(order => 
          order.id === orderId ? { ...order, status: 'Concluído' } : order
        )
      );
    } catch (error) {
      console.error("Erro ao concluir o pedido:", error);
      alert('Ocorreu um erro ao tentar concluir o pedido. Tente novamente.');
    }
  };
  // Efeito para o contador regressivo na etapa de pagamento
  useEffect(() => {
    if (purchaseStep === 4 && pendingOrderId) {
      // Inicia o contador
      setCountdown(5); // Reinicia para 5 segundos
      countdownIntervalRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
            // Quando o tempo acaba, atualiza o pedido para "Expirado"
            const orderDocRef = doc(db, "orders", pendingOrderId);
            updateDoc(orderDocRef, { status: "Expirado" });
            
            // Atualiza o estado local também
            setOrders(prevOrders => prevOrders.map(o => 
              o.id === pendingOrderId ? { ...o, status: 'Expirado' } : o
            ));

            // Avança para a página de "Pedido Expirado"
            setPurchaseStep(5);

            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      // Função de limpeza do useEffect
      return () => {
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
        }
        // Se o componente for desmontado ANTES do contador terminar,
        // garante que o pedido seja marcado como expirado.
        if (purchaseStep === 4 && pendingOrderId && !paymentSucceededRef.current) {
          const orderDocRef = doc(db, "orders", pendingOrderId);
          updateDoc(orderDocRef, { status: "Expirado" });
        }
      };
    }
  }, [purchaseStep, pendingOrderId, orders]);

  // Componente para o indicador de etapas
  const StepIndicator = ({ currentStep }: { currentStep: number }) => (
    <div className="flex justify-center items-center gap-4 my-6">
      {[1, 2, 3, 4].map(step => (
        <div key={step} className={`w-4 h-4 rounded-full transition-colors ${currentStep === step ? 'bg-green-500' : currentStep > step ? 'bg-slate-600' : 'bg-blue-500'}`}></div>
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 text-white">
      {/* Header */}
      <header className="pt-6">
        {/* Contêiner relativo para posicionar o botão e o dropdown */}
        <div className="container mx-auto px-4 max-w-lg relative">
          {/* O texto agora está centralizado corretamente */}
          <div className="text-center">
            <h1 className="text-5xl font-bold text-yellow-500 mb-1">Tibex</h1>
            <p className="text-xl text-gray-300">Tibia Exchange</p>
            <p className="text-sm text-gray-400 mt-2">
              Sua fonte de <span className="text-yellow-500 font-semibold">Tibia Coins</span>.
            </p>
          </div>          

          {/* Botão de Login e Dropdown */}
          <div ref={dropdownRef} className="absolute top-1/2 right-4 -translate-y-1/2">
            <button
              onClick={() => !isDuringPurchase && setIsDropdownOpen(!isDropdownOpen)}
              disabled={isDuringPurchase}
              // A cor da borda agora depende do estado de login
              className={`w-12 h-12 rounded-full bg-slate-800 border-2 flex items-center justify-center transition-colors overflow-hidden ${
                isDuringPurchase ? 'border-slate-700 cursor-not-allowed opacity-50' :
                (loggedInUser ? 'border-green-500 hover:bg-green-500/20' : 'border-slate-600 hover:bg-slate-500/20')
              }`}
            >
              {loggedInUser ? <Avatar user={loggedInUser} /> : (
                <User className="text-slate-400" size={24} />
              )}
            </button>

            {isDropdownOpen && (
              <div className="absolute top-full right-0 mt-2 w-48 bg-slate-700 rounded-md shadow-lg z-10 border border-slate-600">
                {loggedInUser ? (
                  <div className="p-2 text-gray-200">
                    <div className="px-4 py-2 text-sm text-gray-300 break-words">
                      <p className="font-semibold">{loggedInUser.displayName}</p>
                      <p className="truncate">{loggedInUser.email}</p>
                    </div>
                    <button 
                      onClick={() => { 
                        setCurrentView('dashboard'); 
                        setIsDropdownOpen(false); 
                        resetForm();
                        // Define o filtro padrão ao entrar no histórico
                        setHistoryFilter(loggedInUser?.uid === ADMIN_UID ? 'pago' : 'compras');
                      }} 
                      className="block w-full text-left px-4 py-2 text-sm text-gray-200 rounded-md hover:bg-slate-600">
                      Meus Pedidos
                    </button>
                    <div className="border-t border-slate-600 my-1"></div>
                    <button onClick={handleLogout} className="block w-full text-left px-4 py-2 text-sm text-red-400 rounded-md hover:bg-slate-600">
                      Logout
                    </button>
                  </div>
                ) : (
                  <div className="p-2">
                    <button onClick={handleGoogleLogin} className="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm bg-white text-gray-700 font-medium rounded-md hover:bg-gray-100 whitespace-nowrap border border-slate-300">
                      <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 0 24 24" width="18">
                          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                          <path d="M1 1h22v22H1z" fill="none"/>
                      </svg>
                      Entrar com Google</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {currentView === 'exchange' ? (
        // VISUALIZAÇÃO PADRÃO (COMPRA/VENDA)
        <div className="container mx-auto px-4 max-w-lg">
          {purchaseStep === 0 ? (
            // ETAPA 1: FORMULÁRIO DE COMPRA/VENDA
            <>
              {/* Pricing Info */}
              <div className="w-fit mx-auto text-center py-2 mt-3 mb-3 bg-black/20 rounded-lg text-gray-400 text-sm px-4">
                <p>Compre TC a R$ {BUY_PRICE_PER_25_TC.toFixed(2).replace('.', ',')} / 25 TC</p>
                <p>Venda TC a R$ {SELL_PRICE_PER_25_TC.toFixed(2).replace('.', ',')} / 25 TC</p>
              </div>

              <div className="flex gap-2 mb-6">
                <button onClick={() => { setActiveTab('comprar'); resetForm(); }} className={`flex-1 py-3 rounded-lg font-semibold transition-colors ${activeTab === 'comprar' ? 'bg-yellow-600 text-white' : 'bg-slate-700 text-gray-300 hover:bg-slate-600'}`}>
                  Comprar TC
                </button>
                <button onClick={() => { setActiveTab('vender'); resetForm(); }} className={`flex-1 py-3 rounded-lg font-semibold transition-colors ${activeTab === 'vender' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-gray-300 hover:bg-slate-600'}`}>
                  Vender TC
                </button>
              </div>

              {/* Main Content */}
              <div className={`bg-slate-800 rounded-lg p-6 border transition-colors ${activeTab === 'comprar' ? 'border-yellow-600' : 'border-blue-600'}`}>
                <h2 className="text-2xl font-semibold mb-6">{activeTab === 'comprar' ? 'Comprar Tibia Coins (Receber TC)' : 'Vender Tibia Coins (Receber PIX)'}</h2>
                <div>
                  <div className="mb-6">
                    <label className="block text-sm text-gray-300 mb-2">{activeTab === 'comprar' ? 'Quantidade de Tibia Coins (Múltiplos de 25)' : 'Quantidade de Tibia Coins a Vender'}</label>
                    <input 
                      type="number" 
                      value={quantity} 
                      onChange={(e) => setQuantity(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                      onBlur={handleQuantityBlur} 
                      className="w-full bg-slate-700 text-white px-4 py-3 rounded-lg border border-slate-600 focus:border-yellow-500 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" 
                    />
                  </div>
                  <div className="mb-6 bg-slate-700 rounded-lg p-4"><p className="text-sm text-gray-400 mb-1">{activeTab === 'comprar' ? 'Valor Total (PIX a Pagar):' : 'Valor Total (PIX a Receber):'}</p><p className="text-3xl font-bold text-green-400">R$ {totalValue}</p></div>
                  {activeTab === 'vender' && (<>
                    <h3 className="text-xl font-semibold mb-4">Dados do Pagamento PIX</h3>
                    <div className="grid grid-cols-2 gap-4 mb-4">                      
                      <div><label className="block text-sm text-gray-300 mb-2">Tipo de Chave</label><select value={keyType} onChange={handleKeyTypeSelectChange} className="w-full bg-slate-700 text-white px-4 py-3 rounded-lg border border-slate-600 focus:border-yellow-500 focus:outline-none"><option>CPF/CNPJ</option><option>E-mail</option><option>Telefone</option><option>Chave Aleatória</option></select></div>
                      <div>
                        <label className="block text-sm text-gray-300 mb-2">Chave PIX</label>
                        <input 
                          type="text" 
                          value={pixKey} 
                          onChange={handlePixKeyChange} 
                          maxLength={(keyType === 'CPF/CNPJ' || keyType === 'Telefone') ? 15 : undefined}
                          placeholder={ (keyType === 'CPF/CNPJ' || keyType === 'Telefone') ? "Apenas números" : "Sua chave PIX"} className="w-full bg-slate-700 text-white px-4 py-3 rounded-lg border border-slate-600 focus:border-yellow-500 focus:outline-none placeholder-gray-500" /></div>
                    </div>
                    <div className="mb-6">
                      <label className="block text-sm text-gray-300 mb-2">E-mail (Para Notificações)</label>
                      <input type="email" value={email} placeholder="Faça login para preenchimento automático" readOnly={true} className="w-full px-4 py-3 rounded-lg border border-slate-600 focus:border-yellow-500 focus:outline-none placeholder-gray-500 bg-slate-900 cursor-not-allowed text-gray-400" />
                    </div>
                  </>)}
                  <h3 className="text-xl font-semibold mb-4">{activeTab === 'comprar' ? 'Dados para Receber In-Game' : 'Seu Char'}</h3>
                  <div className="mb-4">
                    <label className="block text-sm text-gray-300 mb-2">Nome do Char (Exato)</label>
                    <input type="text" value={charName} onChange={handleCharNameChange} placeholder={activeTab === 'comprar' ? 'Ex: Craban' : 'Ex: Eternal Oblivion'} className="w-full bg-slate-700 text-white px-4 py-3 rounded-lg border border-slate-600 focus:border-yellow-500 focus:outline-none placeholder-gray-500" />
                  </div>
                  <div className="mb-4">
                    <label className="block text-sm text-gray-300 mb-2">World (Servidor)</label>
                    <input type="text" value={world} placeholder={isFetchingChar ? 'Buscando...' : (charError || 'Aguardando nome do personagem...')} readOnly={true} className={`w-full px-4 py-3 rounded-lg border border-slate-600 focus:border-yellow-500 focus:outline-none transition-all bg-slate-900 cursor-not-allowed ${world ? 'text-green-400 font-semibold' : 'text-gray-400'} ${charError ? 'placeholder:text-red-400' : 'placeholder:text-gray-500'}`} />
                  </div>
                  {activeTab === 'comprar' && (
                    <div className="mb-6">
                      <label className="block text-sm text-gray-300 mb-2">E-mail (Para Notificações)</label>
                      <input type="email" value={email} placeholder="Faça login para preenchimento automático" readOnly={true} className="w-full px-4 py-3 rounded-lg border border-slate-600 focus:border-yellow-500 focus:outline-none placeholder-gray-500 bg-slate-900 cursor-not-allowed text-gray-400" />
                    </div>
                  )}
                  <button onClick={() => setPurchaseStep(1)} disabled={isSubmitDisabled} className={`w-full text-white font-bold py-4 rounded-lg transition-colors text-lg ${isSubmitDisabled ? 'bg-slate-600 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}>{loggedInUser ? (isSubmitDisabled ? (activeTab === 'comprar' ? 'Finalizar Compra' : 'Finalizar Venda') : 'Avançar') : 'FAÇA LOGIN PARA CONTINUAR'}</button>
                </div>
              </div>
            </>
          ) : (
            // ETAPAS 1, 2, 3, 4
            <div className="bg-slate-800 rounded-lg shadow-xl w-full max-w-md mx-auto mt-6 border border-slate-700 p-6">
              <StepIndicator currentStep={purchaseStep} />
              {purchaseStep === 1 && (
                <div>
                  <h2 className="text-2xl font-bold text-center text-yellow-400 mb-6">Etapa 1: Detalhes do Produto</h2>
                  <div className="space-y-2 text-lg">
                    <p><span className="text-gray-400">Quantidade:</span> {quantity} Tibia Coins</p>
                    <p><span className="text-gray-400">Pagamento:</span> PIX</p>
                  </div>
                </div>
              )}
              {purchaseStep === 2 && loggedInUser && (
                <div>
                  <h2 className="text-2xl font-bold text-center text-yellow-400 mb-6">Etapa 2: Seus Dados</h2>
                  <div className="space-y-2 text-lg">
                    <p><span className="text-gray-400">Nome:</span> {loggedInUser.displayName}</p>
                    <p><span className="text-gray-400">E-mail:</span> {loggedInUser.email}</p>
                    <div className="border-t border-slate-700 my-3 pt-2"></div>
                    <p><span className="text-gray-400">Personagem:</span> {charName}</p>
                    <p><span className="text-gray-400">Level:</span> {charLevel || 'N/A'}</p>
                    <p><span className="text-gray-400">Servidor:</span> {world}</p>
                  </div>
                </div>
              )}
              {purchaseStep === 3 && loggedInUser && (
                <div>
                  <h2 className="text-2xl font-bold text-center text-yellow-400 mb-6">Etapa 3: Resumo e Confirmação</h2>
                  <div className="space-y-2 text-lg mb-6">
                    <p><span className="text-gray-400">Quantidade:</span> {quantity} Tibia Coins</p>
                    <p><span className="text-gray-400">Valor:</span> R$ {totalValue}</p>
                    <p><span className="text-gray-400">Pagamento:</span> PIX</p>
                    <p><span className="text-gray-400">E-mail:</span> {loggedInUser.email}</p>
                    <div className="border-t border-slate-700 my-3 pt-2"></div>
                    <p><span className="text-gray-400">Personagem:</span> {charName}</p>
                    <p><span className="text-gray-400">Level:</span> {charLevel || 'N/A'}</p>
                    <p><span className="text-gray-400">Servidor:</span> {world}</p>
                  </div>
                  <div className="flex items-center gap-2 mb-6">
                    <input type="checkbox" id="terms" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} className="w-4 h-4 accent-yellow-500" />
                    <label htmlFor="terms" className="text-sm text-gray-300">Eu aceito os <a href="https://tibex.com.br/tos" className="underline hover:text-yellow-400">termos de privacidade e uso</a> dos serviços.</label>
                  </div>
                </div>
              )}
              {purchaseStep === 4 && (
                <div>
                  <h2 className="text-2xl font-bold text-center text-yellow-400 mb-6">Etapa 4: Pagamento</h2>
                  <p className="text-center text-gray-300 mb-4">Realize o pagamento para concluir seu pedido.</p>
                  <div className="bg-slate-700 p-4 rounded-lg text-center">
                    <p className="text-gray-400">Chave PIX (Banco do Brasil API):</p>
                    <p className="font-mono text-lg text-yellow-300 break-all">[CHAVE PIX GERADA AQUI]</p>
                  </div>
                  <p className="text-center text-xs text-slate-500 mt-2 mb-4">
                    *Ao atualizar ou fechar esta página, o pedido será cancelado. Será necessário criar um novo pedido.
                  </p>

                  {/* Botão para simular pagamento */}
                  <div className="text-center mt-4">
                    <button onClick={handleSimulatePayment} className="text-sm bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded-md">[SIMULAR PAGAMENTO]</button>
                  </div>
                  <div className="mt-6">
                    {countdown > 0 ? (
                      <>
                        <p className="text-center text-sm text-red-400 mb-2">O pedido será cancelado em:</p>
                        <div className="w-full bg-slate-700 rounded-full h-4 overflow-hidden">
                          <div className="bg-red-600 h-4 rounded-full" style={{ width: `${(countdown / 5) * 100}%`, transition: 'width 1s linear' }}></div>
                        </div>
                        <p className="text-center font-bold text-xl text-red-500 mt-2">{countdown}s</p>
                      </>
                    ) : <p className="text-center text-red-500 font-bold">Pedido Expirado!</p>}
                  </div>
                  <div className="text-center mt-6">
                    <button onClick={resetForm} className="px-6 py-2 bg-slate-600 hover:bg-slate-500 rounded-lg">Fazer Novo Pedido</button>
                  </div>
                </div>
              )}
              {purchaseStep === 5 && (
                <div>
                  <h2 className="text-2xl font-bold text-center text-red-500 mb-6">Pedido Expirado</h2>
                  <div className="text-center text-gray-300 space-y-2">
                    <p>O tempo para pagamento do seu pedido expirou.</p>
                    <p className="text-sm text-gray-400">ID do Pedido: <span className="font-mono bg-slate-700 px-2 py-1 rounded">{pendingOrderId}</span></p>
                    <p className="text-sm text-gray-400">Nenhum valor foi cobrado.</p>
                  </div>
                </div>
              )}
              {purchaseStep === 6 && (
                <div>
                  <h2 className="text-2xl font-bold text-center text-green-400 mb-6">Pagamento Confirmado!</h2>
                  <div className="text-center text-gray-300 space-y-2">
                    <p>Seu pedido foi recebido e será processado em breve.</p>
                    <p className="text-sm text-gray-400">ID do Pedido: <span className="font-mono bg-slate-700 px-2 py-1 rounded">{pendingOrderId}</span></p>
                    <p>Você receberá os Tibia Coins no personagem <span className="font-semibold text-yellow-400">{charName}</span>.</p>
                  </div>
                </div>
              )}

              {/* Botões de Navegação das Etapas */}
              {purchaseStep < 4 && (
                <div className="flex justify-between mt-8">
                  <button onClick={() => {
                    if (purchaseStep === 3) {
                      setTermsAccepted(false); // Desmarca a caixa de termos ao voltar da etapa 3
                    }
                    setPurchaseStep(p => p - 1);
                  }} className="px-6 py-2 bg-slate-600 hover:bg-slate-500 rounded-lg">Voltar</button>
                  {purchaseStep === 3 ? (
                    <button onClick={handleSubmit} disabled={isConfirmationDisabled} className={`px-6 py-2 rounded-lg font-bold ${isConfirmationDisabled ? 'bg-slate-500 cursor-not-allowed' : 'bg-green-600 hover:bg-green-500'}`}>Comprar</button>
                  ) : (
                    <button onClick={() => setPurchaseStep(p => p + 1)} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg">Avançar</button>
                  )}
                </div>
              )}
              {/* Botão para a etapa 5 (Pedido Expirado) */}
              {(purchaseStep === 5 || purchaseStep === 6) && (
                <div className="text-center mt-8">
                  <button onClick={resetForm} className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-bold">Fazer Novo Pedido</button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        // VISUALIZAÇÃO DO PAINEL DE HISTÓRICO
        <div className="container mx-auto px-4 max-w-lg">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-semibold"> </h2>
            <button onClick={() => { setCurrentView('exchange'); resetForm(); }} className="text-sm text-yellow-500 hover:underline">Voltar</button>
          </div>
          {/* Painel de Métricas do Admin */}
          {loggedInUser?.uid === ADMIN_UID && (
            <div className="grid grid-cols-3 gap-4 mb-6 text-center">
              <div className="bg-green-800/50 p-4 rounded-lg border border-green-700">
                <p className="text-sm text-green-300">Total de Coins Recebidas</p>
                <p className="text-2xl font-bold">{totalCoinsReceived.toLocaleString('pt-BR')} TC</p>
              </div>
              <div className="bg-red-800/50 p-4 rounded-lg border border-red-700">
                <p className="text-sm text-red-300">Total de Coins Enviadas</p>
                <p className="text-2xl font-bold">{totalCoinsSent.toLocaleString('pt-BR')} TC</p>
              </div>
              <div className="bg-blue-800/50 p-4 rounded-lg border border-blue-700">
                <p className="text-sm text-blue-300">Estoque Atual</p>
                <p className={`text-2xl font-bold ${
                  currentStock < 0 ? 'text-red-500' :
                  currentStock >= 25 ? 'text-green-500' :
                  'text-white'
                }`}>{currentStock.toLocaleString('pt-BR')} TC</p>
              </div>
            </div>
          )}
          {/* Filtros do Histórico */}
          <div className="flex gap-2 mb-6">
            {loggedInUser?.uid === ADMIN_UID ? (
              <button onClick={() => { setHistoryFilter('pago'); setCurrentPage(1); setExpandedOrderId(null); }} className={`flex-1 py-3 rounded-lg font-semibold transition-colors ${historyFilter === 'pago' ? 'bg-green-600 text-white' : 'bg-slate-700 text-gray-300 hover:bg-slate-600'}`}>Pago</button>
            ) : (
              <button onClick={() => { setHistoryFilter('todas'); setCurrentPage(1); setExpandedOrderId(null); }} className={`flex-1 py-3 rounded-lg font-semibold transition-colors ${historyFilter === 'todas' ? 'bg-yellow-600 text-white' : 'bg-slate-700 text-gray-300 hover:bg-slate-600'}`}>Todas</button>
            )}
            <button onClick={() => { setHistoryFilter('compras'); setCurrentPage(1); setExpandedOrderId(null); }} className={`flex-1 py-3 rounded-lg font-semibold transition-colors ${historyFilter === 'compras' ? 'bg-yellow-600 text-white' : 'bg-slate-700 text-gray-300 hover:bg-slate-600'}`}>Compras</button>
            <button onClick={() => { setHistoryFilter('vendas'); setCurrentPage(1); setExpandedOrderId(null); }} className={`flex-1 py-3 rounded-lg font-semibold transition-colors ${historyFilter === 'vendas' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-gray-300 hover:bg-slate-600'}`}>Vendas</button>
          </div>

          {/* Box de Conteúdo do Histórico */}
          <div className="bg-slate-800 rounded-lg p-6 border border-slate-700 min-h-[400px] flex flex-col justify-between">
            {/* Lista de Pedidos */}
            {isLoadingOrders ? (
              <p className="text-center text-gray-400 pt-16">Carregando pedidos...</p>
            ) : (
            <div className="space-y-4">
              {currentOrders.length > 0 ? (
                currentOrders.map(order => order.id && ( // Adicionado um condicional para garantir que order.id exista
                  <div 
                    key={order.id} 
                    className={`rounded-lg transition-all duration-300 ${order.type === 'compra' && order.status === 'Pago' ? 'bg-green-900/40 border border-green-700/50' : 'bg-slate-700'}`}
                  >
                    <div 
                      className="p-4 flex justify-between items-center cursor-pointer hover:bg-slate-600/50 rounded-lg"
                      onClick={() => handleOrderToggle(order.id!)}
                    >
                      <div>
                        <p className="font-bold text-lg">{order.type === 'compra' ? 'Compra' : 'Venda'} de {order.quantity} TC</p>
                        <p className="text-sm text-gray-400">{order.date} - {order.charName} ({order.world})</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-lg text-green-400">R$ {order.value}</p>
                        <p className={`text-sm font-semibold ${
                          order.status === 'Concluído' ? 'text-green-500' :
                          order.status === 'Pendente' ? 'text-yellow-500' : 'text-red-500'
                        }`}>{order.status}</p>
                      </div>
                    </div>
                    {/* Detalhes do Pedido - Expansível */}
                    {expandedOrderId === order.id && (
                      <div className="border-t border-slate-600 p-4 text-gray-300 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">ID do Pedido:</span>
                          <span className="text-sm bg-slate-800 px-2 py-1 rounded">{order.id}</span>
                          <button onClick={() => handleCopy(order.id!, 'ID do Pedido')} className="p-1 hover:bg-slate-600 rounded">
                            <Copy size={16} />
                          </button>
                        </div>
                        <p><span className="font-semibold">Data:</span> {order.createdAt.toDate().toLocaleString('pt-BR')}</p>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">Personagem:</span>
                          <span>{order.charName}</span>
                          {loggedInUser?.uid === ADMIN_UID && order.type === 'compra' && order.status === 'Pago' && (
                            <button onClick={() => handleCopy(order.charName, 'Nome do Personagem')} className="p-1 hover:bg-slate-600 rounded"><Copy size={16} /></button>
                          )}
                        </div>
                        <p><span className="font-semibold">Mundo:</span> {order.world}</p>
                        <p><span className="font-semibold">Quantidade:</span> {order.quantity} Tibia Coins</p>
                        <p><span className="font-semibold">Valor:</span> R$ {order.value}</p>
                        <p><span className="font-semibold">Status:</span> <span className={`font-bold ${
                          order.status === 'Concluído' ? 'text-green-400' :
                          order.status === 'Pendente' ? 'text-yellow-400' : 'text-red-400'
                        }`}>{order.status}</span></p>
                        {loggedInUser?.uid === ADMIN_UID && (
                          <div className="border-t border-slate-600 pt-2 mt-2">
                            <p className="font-semibold text-yellow-400">Info do Cliente (Admin):</p>
                            <p><span className="font-semibold">Nome:</span> {order.userDisplayName}</p>
                            <p><span className="font-semibold">Email:</span> {order.userEmail}</p>
                            {order.type === 'venda' && order.pixKey && (
                              <div className="flex items-center gap-2">
                                <span className="font-semibold">Chave PIX ({order.keyType}):</span>
                                <span>{order.pixKey}</span>
                                <button onClick={() => handleCopy(order.pixKey!, 'Chave PIX')} className="p-1 hover:bg-slate-600 rounded"><Copy size={16} /></button>
                              </div>
                            )}
                            <p><span className="font-semibold">User ID:</span> <span className="text-sm">{order.userId}</span></p>
                            {order.type === 'compra' && (
                              <div className="border-t border-slate-600/50 pt-2 mt-2">
                                <p className="font-semibold text-cyan-400">Próxima Ação:</p>                                
                                {order.status === 'Pago' ? (
                                  <div className="flex items-center gap-4 mt-1">
                                    <span>Enviar TC - Pedido Pago</span>
                                    <button onClick={() => handleCompleteOrder(order.id!)} className="bg-green-600 hover:bg-green-700 text-white font-bold py-1 px-3 rounded-md text-sm">Concluir</button>
                                  </div>
                                ) : order.status === 'Concluído' ? (
                                  <span>TC Enviado</span>
                                ) : order.status === 'Pendente' ? (
                                  <span className="text-yellow-400">Aguardando Pagamento</span>
                                ) : (
                                  <span className="text-gray-500">Nenhuma ação pendente</span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-center text-gray-400 pt-16">Nenhum pedido encontrado.</p>
              )}
            </div>
            )}

            {/* Paginação */}
            {totalPages > 1 && (
              <div className="flex justify-center items-center gap-4 mt-6">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-4 py-2 bg-slate-600 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Anterior
                </button>
                <span className="text-gray-300">
                  Página {currentPage} de {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-4 py-2 bg-slate-600 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Próxima
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="text-center py-8 mt-12 text-gray-500 text-sm">
        <p>Tibex - Tibia Exchange ® Todos os direitos reservados.</p>
      </footer>
    </div>
  );
}