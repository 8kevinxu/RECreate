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
