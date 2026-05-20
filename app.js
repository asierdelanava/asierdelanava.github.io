import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-analytics.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";

/* =========================================================
   Configuración Firebase
   ========================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyDvHCmY12MPZXQtxgsD9cRgG8hPlP_16Yk",
  authDomain: "kpicos-4d57f.firebaseapp.com",
  projectId: "kpicos-4d57f",
  storageBucket: "kpicos-4d57f.firebasestorage.app",
  messagingSenderId: "1017372697555",
  appId: "1:1017372697555:web:b62f32e31dd40c65518526",
  measurementId: "G-HP6QXHJBGY"
};

const VERSION_NORMAS = "2026-05";
const ACTIVE_RESERVATION_STATES = ["pendiente", "aprobada", "recogida"];

let firebaseApp;
let analytics;
let auth;
let db;

const state = {
  authMode: "login",
  currentUser: null,
  userProfile: null,
  materials: [],
  searchTerm: "",
  isLoadingMaterials: false,
  materialsError: "",
  openMaterialId: null,
  profileModalOpen: false
};

const els = {
  app: document.getElementById("app"),
  toastRoot: document.getElementById("toast-root")
};

document.addEventListener("DOMContentLoaded", () => {
  initFirebase();
  setupAuthListeners();
  setupDomListeners();
});

/* =========================================================
   Inicialización
   ========================================================= */

function initFirebase() {
  firebaseApp = initializeApp(firebaseConfig);

  // Analytics puede fallar en entornos locales o navegadores restringidos.
  try {
    analytics = getAnalytics(firebaseApp);
  } catch (error) {
    analytics = null;
    console.info("Firebase Analytics no está disponible en este entorno.", error);
  }

  auth = getAuth(firebaseApp);
  db = getFirestore(firebaseApp);
}

function setupAuthListeners() {
  onAuthStateChanged(auth, async (user) => {
    state.currentUser = user;

    if (!user) {
      state.userProfile = null;
      state.materials = [];
      state.openMaterialId = null;
      state.profileModalOpen = false;
      renderLogin();
      return;
    }

    renderAppShellLoading();

    try {
      await loadUserProfile();
      renderApp();

      state.isLoadingMaterials = true;
      renderMaterialCards();

      await loadMaterials();
    } catch (error) {
      console.error(error);
      showToast("error", "Error al iniciar", getFriendlyError(error));
      state.materialsError = getFriendlyError(error);
      renderApp();
    }
  });
}

function setupDomListeners() {
  document.addEventListener("click", async (event) => {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) return;

    const action = actionTarget.dataset.action;

    if (action === "switch-auth-mode") {
      state.authMode = actionTarget.dataset.mode || "login";
      renderLogin();
      return;
    }

    if (action === "logout") {
      await handleLogout();
      return;
    }

    if (action === "open-profile") {
      state.profileModalOpen = true;
      renderApp();
      return;
    }

    if (action === "close-profile") {
      state.profileModalOpen = false;
      renderApp();
      return;
    }

    if (action === "open-reservation-form") {
      openReservationForm(actionTarget.dataset.materialId);
      return;
    }

    if (action === "cancel-reservation") {
      state.openMaterialId = null;
      renderMaterialCards();
      return;
    }

    if (action === "retry-materials") {
      await loadMaterials();
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;

    if (form.id === "auth-form") {
      event.preventDefault();
      await handleAuthSubmit(form);
      return;
    }

    if (form.id === "profile-form") {
      event.preventDefault();
      await saveUserProfile(form);
      return;
    }

    if (form.matches("[data-reservation-form]")) {
      event.preventDefault();
      await createReservation(form);
    }
  });

  document.addEventListener("input", (event) => {
    const input = event.target;
    if (input.dataset.action === "search-materials") {
      state.searchTerm = input.value;
      renderMaterialCards();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.profileModalOpen) {
      state.profileModalOpen = false;
      renderApp();
    }
  });
}

/* =========================================================
   Autenticación
   ========================================================= */

function renderLogin() {
  const isLogin = state.authMode === "login";

  els.app.innerHTML = `
    <main class="auth-layout">
      <section class="auth-card" aria-labelledby="auth-title">
        <div class="auth-brand">
          <div class="brand-mark" aria-hidden="true">100K</div>
          <div>
            <h1 id="auth-title">100K Picos</h1>
            <p>${isLogin ? "Accede para reservar material del club." : "Crea tu cuenta de socio."}</p>
          </div>
        </div>

        <div class="auth-tabs" role="tablist" aria-label="Acceso">
          <button
            type="button"
            class="auth-tab ${isLogin ? "active" : ""}"
            data-action="switch-auth-mode"
            data-mode="login"
            aria-selected="${isLogin}"
          >
            Iniciar sesión
          </button>
          <button
            type="button"
            class="auth-tab ${!isLogin ? "active" : ""}"
            data-action="switch-auth-mode"
            data-mode="register"
            aria-selected="${!isLogin}"
          >
            Registrarse
          </button>
        </div>

        <form id="auth-form" class="form" novalidate>
          ${!isLogin ? `
            <div class="form-row">
              <label for="auth-name">Nombre y apellidos</label>
              <input
                id="auth-name"
                name="name"
                class="input"
                type="text"
                autocomplete="name"
                required
                placeholder="Nombre Apellido"
              />
            </div>
          ` : ""}

          <div class="form-row">
            <label for="auth-email">Email</label>
            <input
              id="auth-email"
              name="email"
              class="input"
              type="email"
              autocomplete="email"
              required
              placeholder="socio@email.com"
            />
          </div>

          <div class="form-row">
            <label for="auth-password">Contraseña</label>
            <input
              id="auth-password"
              name="password"
              class="input"
              type="password"
              autocomplete="${isLogin ? "current-password" : "new-password"}"
              minlength="6"
              required
              placeholder="Mínimo 6 caracteres"
            />
          </div>

          <p id="auth-error" class="error-text" role="alert"></p>

          <button class="btn btn-primary" type="submit">
            ${isLogin ? "Entrar" : "Crear cuenta"}
          </button>
        </form>

        <p class="auth-footer">
          Solo socios autenticados pueden consultar material y solicitar reservas.
        </p>
      </section>
    </main>
  `;
}

async function handleAuthSubmit(form) {
  const submitButton = form.querySelector("button[type='submit']");
  const errorBox = form.querySelector("#auth-error");

  setFormError(errorBox, "");
  submitButton.disabled = true;

  try {
    const formData = new FormData(form);
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");

    if (!email || !password) {
      throw new Error("Introduce email y contraseña.");
    }

    if (state.authMode === "login") {
      await signInWithEmailAndPassword(auth, email, password);
      return;
    }

    const nombre = String(formData.get("name") || "").trim();
    if (!nombre) {
      throw new Error("Introduce tu nombre.");
    }

    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName: nombre });

    await setDoc(doc(db, "usuarios", credential.user.uid), {
      nombre,
      email,
      telefono: "",
      creadoEn: serverTimestamp(),
      actualizadoEn: serverTimestamp()
    });

    showToast("success", "Cuenta creada", "Ya puedes solicitar reservas de material.");
  } catch (error) {
    console.error(error);
    setFormError(errorBox, getFriendlyError(error));
  } finally {
    submitButton.disabled = false;
  }
}

async function handleLogout() {
  try {
    await signOut(auth);
    showToast("success", "Sesión cerrada", "Has salido correctamente.");
  } catch (error) {
    console.error(error);
    showToast("error", "Error al cerrar sesión", getFriendlyError(error));
  }
}

/* =========================================================
   App principal
   ========================================================= */

function renderAppShellLoading() {
  els.app.innerHTML = `
    <section class="screen-loader">
      <div class="loader"></div>
      <p>Cargando tu perfil...</p>
    </section>
  `;
}

function renderApp() {
  const profile = state.userProfile || {};
  const displayName = profile.nombre || state.currentUser?.displayName || "Socio";

  els.app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand">
            <div class="brand-mark" aria-hidden="true">100K</div>
            <div class="brand-text">
              <p class="brand-title">100K Picos</p>
              <p class="brand-subtitle">Reservas de material</p>
            </div>
          </div>

          <div class="topbar-actions">
            <button class="btn btn-secondary" type="button" data-action="open-profile">
              Perfil
            </button>
            <button class="btn btn-ghost" type="button" data-action="logout">
              Cerrar sesión
            </button>
          </div>
        </div>
      </header>

      <main class="main">
        <div class="container">
          <section class="hero" aria-labelledby="main-title">
            <div class="hero-copy">
              <p class="eyebrow">Hola, ${escapeHTML(displayName)}</p>
              <h2 id="main-title">Reservas de material</h2>
              <p>
                Consulta el material disponible del club, revisa próximas reservas y solicita
                una nueva reserva. Todas las solicitudes quedan pendientes de revisión manual.
              </p>
            </div>

            <div class="search-panel">
              <label for="material-search">Buscar material</label>
              <div class="search-input-wrap">
                <span class="search-icon" aria-hidden="true">⌕</span>
                <input
                  id="material-search"
                  class="input"
                  type="search"
                  placeholder="Crampones, piolet, arnés..."
                  value="${escapeHTML(state.searchTerm)}"
                  data-action="search-materials"
                />
              </div>
            </div>
          </section>

          <section id="materials-region" aria-live="polite">
            <div id="materials-grid" class="material-grid"></div>
          </section>
        </div>
      </main>

      ${state.profileModalOpen ? renderProfileModal() : ""}
    </div>
  `;

  renderMaterialCards();
}

function renderProfileModal() {
  const profile = state.userProfile || {};
  const email = profile.email || state.currentUser?.email || "";

  return `
    <div class="modal-backdrop" data-action="close-profile">
      <section
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
        onclick="event.stopPropagation()"
      >
        <header class="modal-header">
          <div>
            <h3 id="profile-title">Perfil</h3>
            <p>Actualiza tus datos de contacto para poder reservar material.</p>
          </div>
          <button class="btn btn-ghost" type="button" data-action="close-profile" aria-label="Cerrar">
            ✕
          </button>
        </header>

        <div class="modal-body">
          <form id="profile-form" class="form" novalidate>
            <div class="form-row">
              <label for="profile-name">Nombre</label>
              <input
                id="profile-name"
                name="nombre"
                class="input"
                type="text"
                autocomplete="name"
                required
                value="${escapeHTML(profile.nombre || "")}"
              />
            </div>

            <div class="form-row">
              <label for="profile-email">Email</label>
              <input
                id="profile-email"
                name="email"
                class="input"
                type="email"
                value="${escapeHTML(email)}"
                disabled
              />
              <p class="input-hint">El email se gestiona desde Firebase Authentication.</p>
            </div>

            <div class="form-row">
              <label for="profile-phone">Teléfono</label>
              <input
                id="profile-phone"
                name="telefono"
                class="input"
                type="tel"
                autocomplete="tel"
                placeholder="600000000"
                value="${escapeHTML(profile.telefono || "")}"
              />
            </div>

            <p id="profile-error" class="error-text" role="alert"></p>

            <div class="form-actions">
              <button class="btn btn-primary" type="submit">Guardar cambios</button>
              <button class="btn btn-secondary" type="button" data-action="close-profile">Cancelar</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

/* =========================================================
   Perfil
   ========================================================= */

async function loadUserProfile() {
  if (!state.currentUser) return null;

  const userRef = doc(db, "usuarios", state.currentUser.uid);
  const snap = await getDoc(userRef);

  if (snap.exists()) {
    state.userProfile = {
      id: snap.id,
      ...snap.data()
    };
    return state.userProfile;
  }

  // Si el usuario existe en Auth pero no en Firestore, se crea el perfil mínimo.
  const fallbackProfile = {
    nombre: state.currentUser.displayName || getNameFromEmail(state.currentUser.email),
    email: state.currentUser.email || "",
    telefono: "",
    creadoEn: serverTimestamp(),
    actualizadoEn: serverTimestamp()
  };

  await setDoc(userRef, fallbackProfile);

  state.userProfile = {
    id: state.currentUser.uid,
    ...fallbackProfile,
    creadoEn: null,
    actualizadoEn: null
  };

  return state.userProfile;
}

async function saveUserProfile(form) {
  const errorBox = form.querySelector("#profile-error");
  const submitButton = form.querySelector("button[type='submit']");
  setFormError(errorBox, "");
  submitButton.disabled = true;

  try {
    if (!state.currentUser) {
      throw new Error("Debes iniciar sesión para actualizar el perfil.");
    }

    const formData = new FormData(form);
    const nombre = String(formData.get("nombre") || "").trim();
    const telefono = String(formData.get("telefono") || "").trim();

    if (!nombre) {
      throw new Error("El nombre no puede estar vacío.");
    }

    await updateDoc(doc(db, "usuarios", state.currentUser.uid), {
      nombre,
      telefono,
      email: state.currentUser.email || "",
      actualizadoEn: serverTimestamp()
    });

    if (state.currentUser.displayName !== nombre) {
      await updateProfile(state.currentUser, { displayName: nombre });
    }

    state.userProfile = {
      ...state.userProfile,
      nombre,
      telefono,
      email: state.currentUser.email || ""
    };

    state.profileModalOpen = false;
    renderApp();
    showToast("success", "Perfil actualizado", "Tus datos se han guardado correctamente.");
  } catch (error) {
    console.error(error);
    setFormError(errorBox, getFriendlyError(error));
  } finally {
    submitButton.disabled = false;
  }
}

/* =========================================================
   Material
   ========================================================= */

async function loadMaterials() {
  state.isLoadingMaterials = true;
  state.materialsError = "";
  renderMaterialCards();

  try {
    // Consulta simple para evitar índices compuestos: filtramos y ordenamos en cliente.
    // Para un club pequeño es más robusto y suficiente.
    const snapshot = await getDocs(collection(db, "material"));

    const visibleMaterials = snapshot.docs
      .map((materialDoc) => ({ id: materialDoc.id, ...materialDoc.data() }))
      .filter((material) => material.activo === true && material.visible === true)
      .sort((a, b) => {
        const orderA = Number.isFinite(a.orden) ? a.orden : 999999;
        const orderB = Number.isFinite(b.orden) ? b.orden : 999999;
        if (orderA !== orderB) return orderA - orderB;
        return String(a.nombre || "").localeCompare(String(b.nombre || ""), "es", { sensitivity: "base" });
      });

    const materials = await Promise.all(visibleMaterials.map(async (baseMaterial) => {
      const material = {
        ...baseMaterial,
        imageUrl: null,
        availableUnits: 0,
        availabilityError: "",
        upcomingReservations: [],
        reservationsError: ""
      };

      if (material.imagenPrincipalPath) {
        try {
          material.imageUrl = await getDownloadURL(ref(storage, material.imagenPrincipalPath));
        } catch (error) {
          console.warn(`No se pudo cargar la imagen de ${material.id}`, error);
          material.imageUrl = null;
        }
      }

      try {
        material.availableUnits = await loadMaterialUnitsCount(material.id);
      } catch (error) {
        console.error(`No se pudo calcular la disponibilidad de ${material.id}`, error);
        material.availableUnits = 0;
        material.availabilityError = getFriendlyError(error);
      }

      try {
        material.upcomingReservations = await loadUpcomingReservations(material.id);
      } catch (error) {
        console.error(`No se pudieron cargar reservas de ${material.id}`, error);
        material.upcomingReservations = [];
        material.reservationsError = getFriendlyError(error);
      }

      return material;
    }));

    state.materials = materials;
  } catch (error) {
    console.error(error);
    state.materialsError = getFriendlyError(error);
    showToast("error", "Error al cargar material", state.materialsError);
  } finally {
    state.isLoadingMaterials = false;
    renderMaterialCards();
  }
}

async function loadMaterialUnitsCount(materialId) {
  // Consulta por colección completa para evitar índices compuestos.
  // Si en el futuro hay muchas unidades, cambia esto por una query indexada.
  const snapshot = await getDocs(collection(db, "unidades_material"));

  return snapshot.docs
    .map((unitDoc) => unitDoc.data())
    .filter((unit) => (
      unit.materialId === materialId
      && unit.activo === true
      && unit.estado === "disponible"
    )).length;
}

async function loadUpcomingReservations(materialId) {
  const today = getStartOfToday();
  const todayMillis = today.getTime();

  // Consulta simple para evitar índice compuesto materialId + estado + fechaFin.
  // La disponibilidad real la revisará administración manualmente.
  const snapshot = await getDocs(collection(db, "reservas"));

  return snapshot.docs
    .map((reservationDoc) => ({
      id: reservationDoc.id,
      ...reservationDoc.data()
    }))
    .filter((reservation) => (
      reservation.materialId === materialId
      && ACTIVE_RESERVATION_STATES.includes(reservation.estado)
      && getTimestampMillis(reservation.fechaFin) >= todayMillis
    ))
    .sort((a, b) => getTimestampMillis(a.fechaInicio) - getTimestampMillis(b.fechaInicio));
}

function renderMaterialCards() {
  const grid = document.getElementById("materials-grid");
  if (!grid) return;

  if (state.isLoadingMaterials) {
    grid.className = "material-grid";
    grid.innerHTML = `
      <div class="content-loader">
        <div class="loader"></div>
        <p>Cargando material del club...</p>
      </div>
    `;
    return;
  }

  if (state.materialsError) {
    grid.className = "";
    grid.innerHTML = `
      <div class="state-card">
        <div class="state-icon" aria-hidden="true">!</div>
        <h3>No se pudo cargar el material</h3>
        <p>${escapeHTML(state.materialsError)}</p>
        <button class="btn btn-primary" type="button" data-action="retry-materials">
          Reintentar
        </button>
      </div>
    `;
    return;
  }

  const filteredMaterials = getFilteredMaterials();

  if (state.materials.length === 0) {
    grid.className = "";
    grid.innerHTML = `
      <div class="state-card">
        <div class="state-icon" aria-hidden="true">⌁</div>
        <h3>No hay material visible</h3>
        <p>Cuando se añadan materiales activos y visibles en Firestore aparecerán aquí.</p>
      </div>
    `;
    return;
  }

  if (filteredMaterials.length === 0) {
    grid.className = "";
    grid.innerHTML = `
      <div class="state-card">
        <div class="state-icon" aria-hidden="true">⌕</div>
        <h3>Sin resultados</h3>
        <p>No hay material que coincida con “${escapeHTML(state.searchTerm)}”.</p>
      </div>
    `;
    return;
  }

  grid.className = "material-grid";
  grid.innerHTML = filteredMaterials.map(renderMaterialCard).join("");
}

function renderMaterialCard(material) {
  const availableUnits = Number(material.availableUnits || 0);
  const canReserve = availableUnits > 0 && !material.availabilityError;
  const isFormOpen = state.openMaterialId === material.id;
  const upcoming = Array.isArray(material.upcomingReservations) ? material.upcomingReservations : [];
  const visibleReservations = upcoming.slice(0, 3);
  const extraReservations = Math.max(0, upcoming.length - visibleReservations.length);

  return `
    <article class="material-card" data-material-id="${escapeHTML(material.id)}">
      <div class="material-media">
        ${material.imageUrl
          ? `<img src="${escapeHTML(material.imageUrl)}" alt="${escapeHTML(material.nombre || "Material del club")}" loading="lazy" />`
          : `<div class="image-placeholder" aria-label="Imagen no disponible"><span>⛰</span></div>`
        }
      </div>

      <div class="material-body">
        <header class="material-header">
          <div class="material-title-row">
            <h3 class="material-title">${escapeHTML(material.nombre || "Material sin nombre")}</h3>
            <span class="badge ${canReserve ? "badge-teal" : "badge-muted"}">
              ${escapeHTML(material.categoria || "Sin categoría")}
            </span>
          </div>

          <div class="material-meta">
            ${material.availabilityError
              ? `<span class="badge badge-warning">Disponibilidad no calculada</span>`
              : canReserve
                ? `<span class="badge badge-success">${availableUnits} ${availableUnits === 1 ? "unidad disponible" : "unidades disponibles"}</span>`
                : `<span class="badge badge-muted">No disponible actualmente</span>`
            }
            ${Number(material.fianza || 0) > 0
              ? `<span class="badge badge-teal">Fianza: ${formatCurrency(material.fianza)}</span>`
              : ""
            }
          </div>
        </header>

        ${material.descripcion
          ? `<p class="material-description">${escapeHTML(material.descripcion)}</p>`
          : ""
        }

        ${Number(material.fianza || 0) > 0
          ? `<p class="material-deposit"><strong>Fianza:</strong> ${formatCurrency(material.fianza)}</p>`
          : ""
        }

        ${material.normasUso
          ? `<p class="material-rules"><strong>Normas de uso:</strong> ${escapeHTML(material.normasUso)}</p>`
          : ""
        }

        <section class="reservations-box">
          <h4>Próximas reservas</h4>
          ${material.reservationsError
            ? `<p class="warning-text visible">No se pudieron cargar las próximas reservas.</p>`
            : visibleReservations.length > 0
              ? `
                <ul class="reservation-list">
                  ${visibleReservations.map(renderReservationItem).join("")}
                </ul>
                ${extraReservations > 0 ? `<p class="empty-inline">+${extraReservations} reservas más</p>` : ""}
              `
              : `<p class="empty-inline">No hay próximas reservas registradas.</p>`
          }
        </section>

        <div class="card-actions">
          <button
            class="btn btn-primary"
            type="button"
            data-action="open-reservation-form"
            data-material-id="${escapeHTML(material.id)}"
            ${canReserve ? "" : "disabled"}
          >
            Reservar
          </button>

          ${!canReserve && !material.availabilityError
            ? `<p class="empty-inline">No hay unidades disponibles para nuevas solicitudes.</p>`
            : ""
          }

          ${isFormOpen ? renderReservationForm(material) : ""}
        </div>
      </div>
    </article>
  `;
}

function renderReservationItem(reservation) {
  return `
    <li class="reservation-item">
      <span class="reservation-person">${escapeHTML(reservation.userName || "Socio")}</span>
      <div class="reservation-details">
        <span>${formatDate(reservation.fechaInicio)} - ${formatDate(reservation.fechaFin)}</span>
        <span class="badge ${getReservationBadgeClass(reservation.estado)}">${escapeHTML(formatReservationStatus(reservation.estado))}</span>
      </div>
    </li>
  `;
}

function renderReservationForm(material) {
  const todayValue = getTodayInputValue();

  return `
    <form class="reservation-form" data-reservation-form data-material-id="${escapeHTML(material.id)}" novalidate>
      <h4 class="reservation-form-title">Solicitar reserva</h4>

      <div class="form-grid-2">
        <div class="form-row">
          <label for="fecha-inicio-${escapeHTML(material.id)}">Fecha inicio</label>
          <input
            id="fecha-inicio-${escapeHTML(material.id)}"
            name="fechaInicio"
            class="input"
            type="date"
            min="${todayValue}"
            required
          />
        </div>

        <div class="form-row">
          <label for="fecha-fin-${escapeHTML(material.id)}">Fecha fin</label>
          <input
            id="fecha-fin-${escapeHTML(material.id)}"
            name="fechaFin"
            class="input"
            type="date"
            min="${todayValue}"
            required
          />
        </div>
      </div>

      <div class="form-row">
        <label for="comentario-${escapeHTML(material.id)}">Comentario opcional</label>
        <textarea
          id="comentario-${escapeHTML(material.id)}"
          name="comentarioUsuario"
          class="textarea"
          placeholder="Ej.: salida prevista, dudas sobre talla, horario aproximado..."
        ></textarea>
      </div>

      <label class="checkbox-row">
        <input name="normasAceptadas" type="checkbox" required />
        <span>Acepto las normas de uso del material.</span>
      </label>

      <p class="warning-text ${state.userProfile?.telefono ? "" : "visible"}">
        Para reservar necesitas guardar tu teléfono en el perfil.
      </p>

      <p class="error-text" role="alert"></p>
      <p class="success-text" role="status"></p>

      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Confirmar reserva</button>
        <button class="btn btn-secondary" type="button" data-action="cancel-reservation">Cancelar</button>
      </div>
    </form>
  `;
}

function openReservationForm(materialId) {
  state.openMaterialId = state.openMaterialId === materialId ? null : materialId;
  renderMaterialCards();
}

/* =========================================================
   Reservas
   ========================================================= */

async function createReservation(form) {
  const errorBox = form.querySelector(".error-text");
  const successBox = form.querySelector(".success-text");
  const submitButton = form.querySelector("button[type='submit']");

  setFormError(errorBox, "");
  setFormSuccess(successBox, "");
  submitButton.disabled = true;

  try {
    if (!state.currentUser) {
      throw new Error("Debes iniciar sesión para reservar.");
    }

    if (!state.userProfile?.telefono) {
      state.profileModalOpen = true;
      renderApp();
      showToast("warning", "Completa tu perfil", "Añade tu teléfono antes de solicitar una reserva.");
      return;
    }

    const materialId = form.dataset.materialId;
    const material = state.materials.find((item) => item.id === materialId);

    if (!material) {
      throw new Error("No se ha encontrado el material seleccionado.");
    }

    const formData = new FormData(form);
    const fechaInicioValue = String(formData.get("fechaInicio") || "");
    const fechaFinValue = String(formData.get("fechaFin") || "");
    const comentarioUsuario = String(formData.get("comentarioUsuario") || "").trim();
    const normasAceptadas = formData.get("normasAceptadas") === "on";

    validateReservationInput(fechaInicioValue, fechaFinValue, normasAceptadas);

    const fechaInicio = dateInputToTimestamp(fechaInicioValue, false);
    const fechaFin = dateInputToTimestamp(fechaFinValue, true);

    await addDoc(collection(db, "reservas"), {
      userId: state.currentUser.uid,
      userName: state.userProfile.nombre || state.currentUser.displayName || getNameFromEmail(state.currentUser.email),
      userEmail: state.currentUser.email || state.userProfile.email || "",
      userPhone: state.userProfile.telefono || "",

      materialId: material.id,
      materialName: material.nombre || "",

      unidadId: null,
      unidadCodigo: null,

      fechaInicio,
      fechaFin,

      estado: "pendiente",

      comentarioUsuario,
      normasAceptadas: true,
      versionNormas: VERSION_NORMAS,

      notasAdmin: "",

      creadaEn: serverTimestamp(),
      actualizadaEn: serverTimestamp(),

      aprobadaPorUid: null,
      aprobadaPorNombre: null,
      aprobadaEn: null,

      rechazadaPorUid: null,
      rechazadaPorNombre: null,
      rechazadaEn: null,
      motivoRechazo: null,

      recogidaEn: null,
      devueltaEn: null
    });

    setFormSuccess(successBox, "Reserva solicitada correctamente. Queda pendiente de revisión.");
    showToast("success", "Reserva solicitada", "La solicitud se ha creado con estado pendiente.");

    form.reset();
    state.openMaterialId = null;

    // Se recarga para reflejar inmediatamente la nueva reserva pendiente.
    await loadMaterials();
  } catch (error) {
    console.error(error);
    setFormError(errorBox, getFriendlyError(error));
  } finally {
    submitButton.disabled = false;
  }
}

function validateReservationInput(fechaInicioValue, fechaFinValue, normasAceptadas) {
  if (!fechaInicioValue || !fechaFinValue) {
    throw new Error("Selecciona fecha de inicio y fecha de fin.");
  }

  const today = getStartOfToday();
  const fechaInicio = dateInputToDate(fechaInicioValue, false);
  const fechaFin = dateInputToDate(fechaFinValue, false);

  if (fechaInicio < today) {
    throw new Error("La fecha de inicio no puede ser anterior a hoy.");
  }

  if (fechaFin < fechaInicio) {
    throw new Error("La fecha de fin no puede ser anterior a la fecha de inicio.");
  }

  if (!normasAceptadas) {
    throw new Error("Debes aceptar las normas de uso del material.");
  }
}

/* =========================================================
   Utilidades
   ========================================================= */

function getFilteredMaterials() {
  const term = normalizeText(state.searchTerm);

  if (!term) return state.materials;

  return state.materials.filter((material) => {
    const searchable = normalizeText([
      material.nombre,
      material.categoria,
      material.descripcion
    ].filter(Boolean).join(" "));

    return searchable.includes(term);
  });
}

function formatDate(value) {
  const date = timestampToDate(value);
  if (!date) return "Sin fecha";

  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function formatCurrency(value) {
  const numeric = Number(value || 0);
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: numeric % 1 === 0 ? 0 : 2
  }).format(numeric);
}

function formatReservationStatus(status) {
  const labels = {
    pendiente: "Pendiente",
    aprobada: "Aprobada",
    recogida: "Recogida"
  };

  return labels[status] || status || "Sin estado";
}

function getReservationBadgeClass(status) {
  if (status === "aprobada") return "badge-success";
  if (status === "recogida") return "badge-teal";
  if (status === "pendiente") return "badge-warning";
  return "badge-muted";
}

function getTodayInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function getStartOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function dateInputToDate(value, endOfDay = false) {
  const [year, month, day] = value.split("-").map(Number);
  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
}

function dateInputToTimestamp(value, endOfDay = false) {
  return Timestamp.fromDate(dateInputToDate(value, endOfDay));
}

function timestampToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function getTimestampMillis(value) {
  const date = timestampToDate(value);
  return date ? date.getTime() : 0;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function getNameFromEmail(email) {
  return String(email || "Socio").split("@")[0] || "Socio";
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setFormError(element, message) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("visible", Boolean(message));
}

function setFormSuccess(element, message) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("visible", Boolean(message));
}

function showToast(type, title, message = "") {
  if (!els.toastRoot) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <strong>${escapeHTML(title)}</strong>
    ${message ? `<p>${escapeHTML(message)}</p>` : ""}
  `;

  els.toastRoot.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 4600);
}

function getFriendlyError(error) {
  const message = error?.message || String(error || "Error desconocido.");

  const firebaseMessages = {
    "auth/invalid-credential": "Email o contraseña incorrectos.",
    "auth/user-not-found": "No existe una cuenta con ese email.",
    "auth/wrong-password": "La contraseña no es correcta.",
    "auth/email-already-in-use": "Ya existe una cuenta con ese email.",
    "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
    "auth/invalid-email": "El formato del email no es válido.",
    "permission-denied": "No tienes permisos para realizar esta operación."
  };

  const code = error?.code || "";
  if (firebaseMessages[code]) return firebaseMessages[code];

  if (message.includes("The query requires an index")) {
    return "Firestore necesita un índice compuesto para esta consulta. Revisa la consola de Firebase.";
  }

  if (message.includes("Missing or insufficient permissions")) {
    return "Faltan permisos en las reglas de Firebase para esta operación.";
  }

  return message.replace(/^Firebase:\s*/i, "");
}
