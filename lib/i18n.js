// Lightweight i18n for HoopMap. A tiny dictionary + context so the chosen
// language persists (AsyncStorage) and changing it re-renders consumers.
//
// Scope today: the Settings page. The scaffold is app-wide ready — wrap a
// component in `useI18n()` and pull strings via `t('key')` to translate more of
// the app over time. Missing keys fall back to English, then to the raw key.
import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'hoopmap.lang';

// Supported languages, shown in the picker (label in English, native name on the
// chip). `id` is what we persist and key the dictionary by.
export const LANGUAGES = [
  { id: 'en', label: 'English', native: 'English' },
  { id: 'zh', label: 'Chinese', native: '中文' },
  { id: 'es', label: 'Spanish', native: 'Español' },
];
export const DEFAULT_LANG = 'en';

const STRINGS = {
  en: {
    settings: 'Settings',
    language: 'Language',
    languageHint: 'Choose your preferred language.',
    account: 'Account',
    dangerZone: 'Danger zone',
    deleteAccount: 'Delete account',
    deleteWarning:
      "This permanently deletes your account and all your data. This can't be undone.",
    deleteConfirm: 'Type {code} to confirm.',
    deletePlaceholder: 'Type {code}',
    deleteButton: 'Delete my account',
    deleting: 'Deleting…',
    deleteError: "Couldn't delete your account. Please try again.",
    deleteSignedOut: 'Sign in to manage your account.',
    cancel: 'Cancel',

    // Bottom navigation
    'nav.home': 'Home',
    'nav.classes': 'Classes',
    'nav.social': 'Social',
    'nav.profile': 'Profile',

    // Sport names (app label set)
    'sport.basketball': 'Basketball',
    'sport.volleyball': 'Volleyball',
    'sport.pingpong': 'Ping Pong',
    'sport.pickleball': 'Pickleball',
    'sport.tennis': 'Tennis',

    // Profile / account (AuthModal)
    'auth.account': 'Account',
    'auth.signIn': 'Sign in',
    'auth.createAccount': 'Create account',
    'auth.signedInAs': 'Signed in as',
    'auth.editProfile': 'Edit profile',
    'auth.save': 'Save',
    'auth.displayName': 'Display name',
    'auth.age': 'Age',
    'auth.ageMeta': 'Age {age}',
    'auth.neighborhoodPh': 'Neighborhood — e.g. Mission, Sunset, Richmond',
    'auth.bioPh': 'Bio — your game, when you play, who to look for…',
    'auth.favoriteSports': 'Favorite sports',
    'auth.yourName': 'Your name',
    'auth.yourCheckins': 'Your check-ins',
    'auth.noCheckins': 'No check-ins yet — open a court and tap “I played here.”',
    'auth.mostPlayedPre': '🔥 Most-played:',
    'auth.at': 'at',
    'auth.favoritePark': '⭐ Favorite park:',
    'auth.checkin': 'check-in',
    'auth.checkins': 'check-ins',
    'auth.visit': 'visit',
    'auth.visits': 'visits',
    'auth.totalCheckins': '{count} total check-ins',
    'auth.email': 'Email',
    'auth.password': 'Password',
    'auth.signOut': 'Sign out',
    'auth.friends': '👥 Friends',
    'auth.noAccount': 'No account? Create one',
    'auth.haveAccount': 'Have an account? Sign in',
    'auth.errCreds': 'Email and password are required.',
    'auth.errPwLen': 'Password must be at least 6 characters.',
    'auth.infoConfirm': 'Check your email to confirm your account, then sign in.',
    'auth.errAge': 'Age must be a number between 13 and 120.',
    'auth.saved': '✓ Profile saved.',
    'auth.discardTitle': 'Discard changes?',
    'auth.discardBody': 'Leave without saving your changes?',
    'auth.keepEditing': 'Keep editing',
    'auth.discard': 'Discard',

    // Shared
    filters: 'Filters',
    clearAll: 'Clear all',
    directions: 'Directions',

    // Relative time ("…ago")
    'ago.justNow': 'just now',
    'ago.sec': '{n}s ago',
    'ago.min': '{n}m ago',
    'ago.hour': '{n}h ago',

    // Class category chips (app label set)
    'cat.all': 'All',
    'cat.fitness': 'Fitness',
    'cat.dance': 'Dance',
    'cat.music': 'Music',
    'cat.arts': 'Arts',
    'cat.photo': 'Photography',
    'cat.social': 'Social',

    // Classes tab
    'classes.title': 'Classes & Activities',
    'classes.sub': 'Drop-in programs at SF rec centers',
    'classes.searchPh': 'Search classes or rec centers',
    'classes.classOne': 'class',
    'classes.classMany': 'classes',
    'classes.liveLoading': 'Checking live availability…',
    'classes.liveOk': 'Live availability · updated {ago}',
    'classes.liveFail': 'Showing saved availability — pull to refresh',
    'classes.empty': 'No classes match — try a different search or filters.',
    'classes.dropIn': 'Drop-in',
    'classes.register': 'Register',
    'classes.lotsSpots': 'Lots of spots',
    'classes.full': 'Full',
    'classes.left': '{n} left',
    'classes.openings': '{n} openings',
    'classes.show': 'Show',
    'classes.disclaimer':
      'From SF Rec & Park (ActiveNet) — verify times and registration on sfrecpark.org before heading out. Tap a class for details.',

    // Filter sheet
    'filter.age': 'Age',
    'filter.availability': 'Availability',
    'filter.cost': 'Cost',
    'filter.distance': 'Distance',
    'filter.teen': 'Teen',
    'filter.hasSpots': 'Has spots',
    'filter.freeOnly': 'Free only',
    'filter.distChip': '< {r} mi',

    // Shared
    delete: 'Delete',

    // Social tab + chat
    'social.activity': 'Activity',
    'social.chats': 'Chats',
    'chat.now': 'now',
    'chat.minShort': '{n}m',
    'chat.hourShort': '{n}h',
    'chat.dayShort': '{n}d',
    'chat.youPrefix': 'You: ',
    'chat.backChats': '‹ Chats',
    'chat.deletedTitle': 'Deleted chats',
    'chat.noDeleted': 'No deleted chats.',
    'chat.restore': 'Restore',
    'chat.messageFriend': 'Message a friend',
    'chat.empty':
      'No chats yet. Join a run or “down to hoop” to land in its group chat, or message a friend above.',
    'chat.deletedCount': '🗑  Deleted ({n})',
    'chat.noMessagesGroup': 'No messages yet — say hi to the group.',
    'chat.noMessagesDirect': 'No messages yet — say hi.',
    'chat.messagePh': 'Message',
    'chat.send': 'Send',
  },
  zh: {
    settings: '设置',
    language: '语言',
    languageHint: '选择您的首选语言。',
    account: '账户',
    dangerZone: '危险区域',
    deleteAccount: '删除账户',
    deleteWarning: '这将永久删除您的账户和所有数据。此操作无法撤销。',
    deleteConfirm: '输入 {code} 以确认。',
    deletePlaceholder: '输入 {code}',
    deleteButton: '删除我的账户',
    deleting: '正在删除…',
    deleteError: '无法删除您的账户，请重试。',
    deleteSignedOut: '登录以管理您的账户。',
    cancel: '取消',

    // Bottom navigation
    'nav.home': '首页',
    'nav.classes': '课程',
    'nav.social': '社交',
    'nav.profile': '我的',

    // Sport names (app label set)
    'sport.basketball': '篮球',
    'sport.volleyball': '排球',
    'sport.pingpong': '乒乓球',
    'sport.pickleball': '匹克球',
    'sport.tennis': '网球',

    // Profile / account (AuthModal)
    'auth.account': '账户',
    'auth.signIn': '登录',
    'auth.createAccount': '创建账户',
    'auth.signedInAs': '已登录为',
    'auth.editProfile': '编辑资料',
    'auth.save': '保存',
    'auth.displayName': '显示名称',
    'auth.age': '年龄',
    'auth.ageMeta': '{age} 岁',
    'auth.neighborhoodPh': '社区 — 例如 Mission、Sunset、Richmond',
    'auth.bioPh': '简介 — 你的打法、何时打球、找谁…',
    'auth.favoriteSports': '喜爱的运动',
    'auth.yourName': '你的名字',
    'auth.yourCheckins': '你的签到',
    'auth.noCheckins': '还没有签到 — 打开一个球场并点击"我打过这里"。',
    'auth.mostPlayedPre': '🔥 最常打:',
    'auth.at': '于',
    'auth.favoritePark': '⭐ 最爱球场:',
    'auth.checkin': '次签到',
    'auth.checkins': '次签到',
    'auth.visit': '次到访',
    'auth.visits': '次到访',
    'auth.totalCheckins': '共 {count} 次签到',
    'auth.email': '邮箱',
    'auth.password': '密码',
    'auth.signOut': '退出登录',
    'auth.friends': '👥 好友',
    'auth.noAccount': '没有账户？创建一个',
    'auth.haveAccount': '已有账户？登录',
    'auth.errCreds': '需要填写邮箱和密码。',
    'auth.errPwLen': '密码至少需要 6 个字符。',
    'auth.infoConfirm': '请查收邮件确认账户，然后登录。',
    'auth.errAge': '年龄必须是 13 到 120 之间的数字。',
    'auth.saved': '✓ 资料已保存。',
    'auth.discardTitle': '放弃更改？',
    'auth.discardBody': '离开而不保存更改？',
    'auth.keepEditing': '继续编辑',
    'auth.discard': '放弃',

    // Shared
    filters: '筛选',
    clearAll: '清除全部',
    directions: '导航',

    // Relative time ("…ago")
    'ago.justNow': '刚刚',
    'ago.sec': '{n} 秒前',
    'ago.min': '{n} 分钟前',
    'ago.hour': '{n} 小时前',

    // Class category chips (app label set)
    'cat.all': '全部',
    'cat.fitness': '健身',
    'cat.dance': '舞蹈',
    'cat.music': '音乐',
    'cat.arts': '艺术',
    'cat.photo': '摄影',
    'cat.social': '社交',

    // Classes tab
    'classes.title': '课程与活动',
    'classes.sub': '旧金山活动中心的免预约项目',
    'classes.searchPh': '搜索课程或活动中心',
    'classes.classOne': '门课程',
    'classes.classMany': '门课程',
    'classes.liveLoading': '正在查询实时名额…',
    'classes.liveOk': '实时名额 · {ago}更新',
    'classes.liveFail': '显示已保存的名额 — 下拉刷新',
    'classes.empty': '没有匹配的课程 — 换个搜索或筛选条件。',
    'classes.dropIn': '免预约',
    'classes.register': '需注册',
    'classes.lotsSpots': '名额充足',
    'classes.full': '已满',
    'classes.left': '剩 {n} 个',
    'classes.openings': '{n} 个名额',
    'classes.show': '显示',
    'classes.disclaimer':
      '数据来自 SF Rec & Park（ActiveNet）— 出发前请在 sfrecpark.org 核实时间和报名信息。点击课程查看详情。',

    // Filter sheet
    'filter.age': '年龄',
    'filter.availability': '名额',
    'filter.cost': '费用',
    'filter.distance': '距离',
    'filter.teen': '青少年',
    'filter.hasSpots': '有名额',
    'filter.freeOnly': '仅免费',
    'filter.distChip': '< {r} 英里',

    // Shared
    delete: '删除',

    // Social tab + chat
    'social.activity': '动态',
    'social.chats': '聊天',
    'chat.now': '现在',
    'chat.minShort': '{n}分',
    'chat.hourShort': '{n}时',
    'chat.dayShort': '{n}天',
    'chat.youPrefix': '你: ',
    'chat.backChats': '‹ 聊天',
    'chat.deletedTitle': '已删除的聊天',
    'chat.noDeleted': '没有已删除的聊天。',
    'chat.restore': '恢复',
    'chat.messageFriend': '给好友发消息',
    'chat.empty': '还没有聊天。加入一个约局或"想打球"动态即可进入它的群聊，或在上方给好友发消息。',
    'chat.deletedCount': '🗑  已删除 ({n})',
    'chat.noMessagesGroup': '还没有消息 — 跟大家打个招呼吧。',
    'chat.noMessagesDirect': '还没有消息 — 打个招呼吧。',
    'chat.messagePh': '消息',
    'chat.send': '发送',
  },
  es: {
    settings: 'Ajustes',
    language: 'Idioma',
    languageHint: 'Elige tu idioma preferido.',
    account: 'Cuenta',
    dangerZone: 'Zona de peligro',
    deleteAccount: 'Eliminar cuenta',
    deleteWarning:
      'Esto elimina permanentemente tu cuenta y todos tus datos. No se puede deshacer.',
    deleteConfirm: 'Escribe {code} para confirmar.',
    deletePlaceholder: 'Escribe {code}',
    deleteButton: 'Eliminar mi cuenta',
    deleting: 'Eliminando…',
    deleteError: 'No se pudo eliminar tu cuenta. Inténtalo de nuevo.',
    deleteSignedOut: 'Inicia sesión para gestionar tu cuenta.',
    cancel: 'Cancelar',

    // Bottom navigation
    'nav.home': 'Inicio',
    'nav.classes': 'Clases',
    'nav.social': 'Social',
    'nav.profile': 'Perfil',

    // Sport names (app label set)
    'sport.basketball': 'Baloncesto',
    'sport.volleyball': 'Voleibol',
    'sport.pingpong': 'Ping Pong',
    'sport.pickleball': 'Pickleball',
    'sport.tennis': 'Tenis',

    // Profile / account (AuthModal)
    'auth.account': 'Cuenta',
    'auth.signIn': 'Iniciar sesión',
    'auth.createAccount': 'Crear cuenta',
    'auth.signedInAs': 'Sesión iniciada como',
    'auth.editProfile': 'Editar perfil',
    'auth.save': 'Guardar',
    'auth.displayName': 'Nombre visible',
    'auth.age': 'Edad',
    'auth.ageMeta': '{age} años',
    'auth.neighborhoodPh': 'Barrio — p. ej. Mission, Sunset, Richmond',
    'auth.bioPh': 'Bio — tu juego, cuándo juegas, a quién buscar…',
    'auth.favoriteSports': 'Deportes favoritos',
    'auth.yourName': 'Tu nombre',
    'auth.yourCheckins': 'Tus registros',
    'auth.noCheckins': 'Aún no hay registros — abre una cancha y toca "Jugué aquí".',
    'auth.mostPlayedPre': '🔥 Más jugado:',
    'auth.at': 'en',
    'auth.favoritePark': '⭐ Cancha favorita:',
    'auth.checkin': 'registro',
    'auth.checkins': 'registros',
    'auth.visit': 'visita',
    'auth.visits': 'visitas',
    'auth.totalCheckins': '{count} registros en total',
    'auth.email': 'Correo',
    'auth.password': 'Contraseña',
    'auth.signOut': 'Cerrar sesión',
    'auth.friends': '👥 Amigos',
    'auth.noAccount': '¿Sin cuenta? Crea una',
    'auth.haveAccount': '¿Tienes cuenta? Inicia sesión',
    'auth.errCreds': 'Se requieren correo y contraseña.',
    'auth.errPwLen': 'La contraseña debe tener al menos 6 caracteres.',
    'auth.infoConfirm': 'Revisa tu correo para confirmar tu cuenta y luego inicia sesión.',
    'auth.errAge': 'La edad debe ser un número entre 13 y 120.',
    'auth.saved': '✓ Perfil guardado.',
    'auth.discardTitle': '¿Descartar cambios?',
    'auth.discardBody': '¿Salir sin guardar los cambios?',
    'auth.keepEditing': 'Seguir editando',
    'auth.discard': 'Descartar',

    // Shared
    filters: 'Filtros',
    clearAll: 'Borrar todo',
    directions: 'Cómo llegar',

    // Relative time ("…ago")
    'ago.justNow': 'justo ahora',
    'ago.sec': 'hace {n}s',
    'ago.min': 'hace {n} min',
    'ago.hour': 'hace {n} h',

    // Class category chips (app label set)
    'cat.all': 'Todas',
    'cat.fitness': 'Fitness',
    'cat.dance': 'Baile',
    'cat.music': 'Música',
    'cat.arts': 'Arte',
    'cat.photo': 'Fotografía',
    'cat.social': 'Social',

    // Classes tab
    'classes.title': 'Clases y actividades',
    'classes.sub': 'Programas sin cita en centros recreativos de SF',
    'classes.searchPh': 'Buscar clases o centros',
    'classes.classOne': 'clase',
    'classes.classMany': 'clases',
    'classes.liveLoading': 'Comprobando disponibilidad…',
    'classes.liveOk': 'Disponibilidad en vivo · actualizado {ago}',
    'classes.liveFail': 'Mostrando disponibilidad guardada — desliza para actualizar',
    'classes.empty': 'Sin clases — prueba otra búsqueda o filtros.',
    'classes.dropIn': 'Sin cita',
    'classes.register': 'Inscripción',
    'classes.lotsSpots': 'Muchos cupos',
    'classes.full': 'Lleno',
    'classes.left': 'Quedan {n}',
    'classes.openings': '{n} cupos',
    'classes.show': 'Mostrar',
    'classes.disclaimer':
      'De SF Rec & Park (ActiveNet) — verifica horarios e inscripción en sfrecpark.org antes de ir. Toca una clase para ver detalles.',

    // Filter sheet
    'filter.age': 'Edad',
    'filter.availability': 'Disponibilidad',
    'filter.cost': 'Costo',
    'filter.distance': 'Distancia',
    'filter.teen': 'Adolescente',
    'filter.hasSpots': 'Con cupos',
    'filter.freeOnly': 'Solo gratis',
    'filter.distChip': '< {r} mi',

    // Shared
    delete: 'Eliminar',

    // Social tab + chat
    'social.activity': 'Actividad',
    'social.chats': 'Chats',
    'chat.now': 'ahora',
    'chat.minShort': '{n}m',
    'chat.hourShort': '{n}h',
    'chat.dayShort': '{n}d',
    'chat.youPrefix': 'Tú: ',
    'chat.backChats': '‹ Chats',
    'chat.deletedTitle': 'Chats eliminados',
    'chat.noDeleted': 'No hay chats eliminados.',
    'chat.restore': 'Restaurar',
    'chat.messageFriend': 'Mensaje a un amigo',
    'chat.empty':
      'Aún no hay chats. Únete a un partido o a un “a jugar” para entrar en su chat grupal, o envía un mensaje a un amigo arriba.',
    'chat.deletedCount': '🗑  Eliminados ({n})',
    'chat.noMessagesGroup': 'Aún no hay mensajes — saluda al grupo.',
    'chat.noMessagesDirect': 'Aún no hay mensajes — saluda.',
    'chat.messagePh': 'Mensaje',
    'chat.send': 'Enviar',
  },
};

// Resolve a key for a language, then fill {placeholders} from `vars`.
function translate(lang, key, vars) {
  const str = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
  return vars ? str.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : str;
}

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(DEFAULT_LANG);

  // Restore the saved language on launch.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((v) => {
      if (v && STRINGS[v]) setLangState(v);
    });
  }, []);

  const setLang = (l) => {
    if (!STRINGS[l]) return;
    setLangState(l);
    AsyncStorage.setItem(STORAGE_KEY, l).catch(() => {});
  };

  const t = (key, vars) => translate(lang, key, vars);

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

// Translate an app sport id (lib/sports.js) to the current language.
export function sportLabel(t, id) {
  return t('sport.' + id);
}

// Usable without a provider (falls back to English) so callers stay unconditional.
export function useI18n() {
  return (
    useContext(I18nContext) || {
      lang: DEFAULT_LANG,
      setLang: () => {},
      t: (key, vars) => translate(DEFAULT_LANG, key, vars),
    }
  );
}
