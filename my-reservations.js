import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-analytics.js";
import {
  getAuth,
  onAuthStateChanged,
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
  query,
  where,
  orderBy,
  serverTimestamp
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

const ACTIVE_STATES = ["pendiente", "aprobada", "recogida", "incidencia"];
const FUTURE_EXCLUDED_STATES = ["devuelta", "rechazada", "cancelada", "vencida"];

let firebaseApp;
let analytics;
let auth;
let db;

const state = {
  currentUser: null,
  userProfile: null,
  reservations: [],
  materialsById: new Map(),
  isLoading: true,
  error: "",
  profileModalOpen: false,
  actionModal: null
};

const els = {
  app: document.getElementById("app"),
  toastRoot: document.getElementById("toast-root")
};

document.addEventListener("DOMContentLoaded", () => {
  initFirebase();
  setupAuth();
  setupDomListeners();
});

/* =========================================================
   Inicialización y autenticación
   ========================================================= */

function initFirebase() {
  firebaseApp = initializeApp(firebaseConfig);

  try {
    analytics = getAnalytics(firebaseApp);
  } catch (error) {
    analytics = null;
    console.info("Firebase Analytics no está disponible en este entorno.", error);
  }

  auth = getAuth(firebaseApp);
  db = getFirestore(firebaseApp);
}

function setupAuth() {
  onAuthStateChanged(auth, async (user) => {
    state.currentUser = user;

    if (!user) {
      state.userProfile = null;
      state.reservations = [];
      state.isLoading = false;
      renderLoggedOut();
      return;
    }

    setLoading(true);

    try {
      await loadUserProfile();
      renderShell();
      await loadUserReservations();
    } catch (error) {
      console.error(error);
      state.error = getFriendlyError(error);
      showToast("error", "Error al cargar reservas", state.error);
      renderShell();
    } finally {
      setLoading(false);
    }
  });
}

function setupDomListeners() {
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const action = target.dataset.action;

    if (action === "logout") {
      await handleLogout();
      return;
    }

    if (action === "open-profile") {
      state.profileModalOpen = true;
      renderShell();
      return;
    }

    if (action === "close-profile") {
      state.profileModalOpen = false;
      renderShell();
      return;
    }

    if (action === "retry") {
      await loadUserReservations();
      return;
    }

    if (action === "open-pickup-modal") {
      openPickupModal(target.dataset.reservationId);
      return;
    }

    if (action === "open-return-modal") {
      openReturnModal(target.dataset.reservationId);
      return;
    }

    if (action === "close-action-modal") {
      state.actionModal = null;
      renderShell();
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;

    if (form.id === "profile-form") {
      event.preventDefault();
      await saveUserProfile(form);
      return;
    }

    if (form.id === "pickup-form") {
      event.preventDefault();
      await confirmPickup(form);
      return;
    }

    if (form.id === "return-form") {
      event.preventDefault();
      await confirmReturn(form);
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input.matches("input[type='file'][data-file-preview]")) {
      const preview = document.querySelector(input.dataset.filePreview);
      if (preview) {
        preview.textContent = input.files?.[0]?.name || "Ningún archivo seleccionado";
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    if (state.actionModal) {
      state.actionModal = null;
      renderShell();
      return;
    }

    if (state.profileModalOpen) {
      state.profileModalOpen = false;
      renderShell();
    }
  });
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

async function loadUserProfile() {
  if (!state.currentUser) return null;

  const userRef = doc(db, "usuarios", state.currentUser.uid);
  const snap = await getDoc(userRef);

  if (snap.exists()) {
    state.userProfile = { id: snap.id, ...snap.data() };
    return state.userProfile;
  }

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
    renderShell();
    showToast("success", "Perfil actualizado", "Tus datos se han guardado correctamente.");
  } catch (error) {
    console.error(error);
    setFormError(errorBox, getFriendlyError(error));
  } finally {
    submitButton.disabled = false;
  }
}

/* =========================================================
   Carga de reservas
   ========================================================= */

async function loadUserReservations() {
  if (!state.currentUser) return;

  setLoading(true);
  state.error = "";
  renderReservations();

  try {
    const reservationsRef = collection(db, "reservas");
    let snapshot;

    try {
      // Consulta deseada. Si falta el índice userId + fechaInicio, se usa fallback sin orderBy.
      const orderedQuery = query(
        reservationsRef,
        where("userId", "==", state.currentUser.uid),
        orderBy("fechaInicio", "desc")
      );
      snapshot = await getDocs(orderedQuery);
    } catch (error) {
      console.warn("No se pudo usar orderBy en Firestore. Se ordenará en cliente.", error);
      const fallbackQuery = query(reservationsRef, where("userId", "==", state.currentUser.uid));
      snapshot = await getDocs(fallbackQuery);
    }

    const reservations = snapshot.docs.map((reservationDoc) => ({
      id: reservationDoc.id,
      ...reservationDoc.data(),
      materialImageUrl: null
    }));

    await hydrateReservationsWithMaterials(reservations);

    state.reservations = sortReservations(reservations);
  } catch (error) {
    console.error(error);
    state.error = getFriendlyError(error);
    showToast("error", "No se pudieron cargar tus reservas", state.error);
  } finally {
    setLoading(false);
  }
}

async function hydrateReservationsWithMaterials(reservations) {
  const materialIds = [...new Set(reservations.map((reservation) => reservation.materialId).filter(Boolean))];

  await Promise.all(materialIds.map(async (materialId) => {
    if (state.materialsById.has(materialId)) return;

    try {
      const materialSnap = await getDoc(doc(db, "material", materialId));
      if (!materialSnap.exists()) {
        state.materialsById.set(materialId, null);
        return;
      }

      const material = { id: materialSnap.id, ...materialSnap.data() };
      material.imageUrl = loadMaterialImage(material);
      state.materialsById.set(materialId, material);
    } catch (error) {
      console.warn(`No se pudo cargar el material ${materialId}.`, error);
      state.materialsById.set(materialId, null);
    }
  }));

  for (const reservation of reservations) {
    const material = state.materialsById.get(reservation.materialId);
    reservation.materialImageUrl = material?.imageUrl || null;
    reservation.materialCategory = material?.categoria || "";
  }
}

function sortReservations(reservations) {
  return [...reservations].sort((a, b) => {
    const groupA = getReservationGroup(a);
    const groupB = getReservationGroup(b);

    if (groupA !== groupB) return groupA - groupB;

    return getTimestampMillis(b.fechaInicio) - getTimestampMillis(a.fechaInicio);
  });
}

function getReservationGroup(reservation) {
  if (ACTIVE_STATES.includes(reservation.estado)) return 0;

  const startMillis = getTimestampMillis(reservation.fechaInicio);
  const todayMillis = getStartOfToday().getTime();

  if (!FUTURE_EXCLUDED_STATES.includes(reservation.estado) && startMillis >= todayMillis) {
    return 1;
  }

  return 2;
}

function loadMaterialImage(material) {
  const rawUrl = String(material.imagenUrl || material.imagenPrincipalPath || "").trim();
  if (!rawUrl) return null;

  // Sin Firebase Storage por ahora: solo se aceptan URLs absolutas o rutas locales publicadas con la web.
  // En el futuro, si se activa Storage, aquí se conectaría getDownloadURL(ref(storage, rawUrl)).
  if (/^(https?:)?\/\//i.test(rawUrl) || rawUrl.startsWith("/") || rawUrl.startsWith("./") || rawUrl.startsWith("img/")) {
    return rawUrl;
  }

  return null;
}

/* =========================================================
   Render
   ========================================================= */

function renderLoggedOut() {
  els.app.innerHTML = `
    <main class="screen-loader">
      <section class="state-card">
        <div class="state-icon" aria-hidden="true">100K</div>
        <h3>Inicia sesión para ver tus reservas</h3>
        <p>Accede desde la página principal para consultar solicitudes, recogidas y devoluciones.</p>
        <a class="btn btn-primary" href="index.html">Ir al inicio</a>
      </section>
    </main>
  `;
}

function renderShell() {
  if (!state.currentUser) {
    renderLoggedOut();
    return;
  }

  const profile = state.userProfile || {};
  const displayName = profile.nombre || state.currentUser.displayName || "Socio";
  const summary = getReservationSummary();

  els.app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand">
            <div class="brand-mark" aria-hidden="true">100K</div>
            <div class="brand-text">
              <p class="brand-title">100K Picos</p>
              <p class="brand-subtitle">Mis reservas</p>
            </div>
          </div>

          <div class="topbar-actions">
            <a class="btn btn-secondary" href="index.html">Inicio</a>
            <button class="btn btn-secondary" type="button" data-action="open-profile">Perfil</button>
            <button class="btn btn-ghost" type="button" data-action="logout">Cerrar sesión</button>
          </div>
        </div>
      </header>

      <main class="main">
        <div class="container">
          <section class="hero" aria-labelledby="page-title">
            <div>
              <p class="eyebrow">Hola, ${escapeHTML(displayName)}</p>
              <h1 id="page-title">Mis reservas</h1>
              <p>
                Consulta el estado de tus solicitudes, revisa fechas y marca la recogida o devolución
                cuando corresponda.
              </p>
            </div>

            <div class="summary-strip" aria-label="Resumen de reservas">
              <div class="summary-item">
                <strong>${summary.total}</strong>
                <span>Total</span>
              </div>
              <div class="summary-item">
                <strong>${summary.active}</strong>
                <span>Activas</span>
              </div>
              <div class="summary-item">
                <strong>${summary.pending}</strong>
                <span>Pendientes</span>
              </div>
              <div class="summary-item">
                <strong>${summary.picked}</strong>
                <span>Recogidas</span>
              </div>
            </div>
          </section>

          <section id="reservations-region" aria-live="polite">
            <div id="reservations-list" class="reservation-list"></div>
          </section>
        </div>
      </main>

      ${state.profileModalOpen ? renderProfileModal() : ""}
      ${state.actionModal ? renderActionModal() : ""}
    </div>
  `;

  renderReservations();
}

function renderReservations() {
  const list = document.getElementById("reservations-list");
  if (!list) return;

  if (state.isLoading) {
    list.innerHTML = `
      <div class="skeleton-list" aria-label="Cargando reservas">
        <div class="skeleton-card"></div>
        <div class="skeleton-card"></div>
        <div class="skeleton-card"></div>
      </div>
    `;
    return;
  }

  if (state.error) {
    list.innerHTML = `
      <div class="state-card">
        <div class="state-icon" aria-hidden="true">!</div>
        <h3>No se pudieron cargar tus reservas</h3>
        <p>${escapeHTML(state.error)}</p>
        <button class="btn btn-primary" type="button" data-action="retry">Reintentar</button>
      </div>
    `;
    return;
  }

  if (state.reservations.length === 0) {
    list.innerHTML = `
      <div class="state-card">
        <div class="state-icon" aria-hidden="true">⌁</div>
        <h3>Todavía no has realizado ninguna solicitud de material.</h3>
        <p>Cuando solicites una reserva desde el listado de material, aparecerá aquí con su estado actualizado.</p>
        <a class="btn btn-primary" href="index.html">Ver material</a>
      </div>
    `;
    return;
  }

  list.innerHTML = state.reservations.map(renderReservationCard).join("");
}

function renderReservationCard(reservation) {
  return `
    <article class="reservation-card" data-reservation-id="${escapeHTML(reservation.id)}">
      <div class="reservation-media">
        ${reservation.materialImageUrl
          ? `<img src="${escapeHTML(reservation.materialImageUrl)}" alt="${escapeHTML(reservation.materialName || "Material del club")}" loading="lazy" />`
          : `<div class="image-placeholder" aria-label="Imagen no disponible"><span>⛰</span></div>`
        }
      </div>

      <div class="reservation-body">
        <header class="reservation-header">
          <div class="reservation-title-row">
            <div>
              <h2 class="reservation-title">${escapeHTML(reservation.materialName || "Material sin nombre")}</h2>
              ${reservation.materialCategory ? `<p class="empty-inline">${escapeHTML(reservation.materialCategory)}</p>` : ""}
            </div>
            ${getStatusBadge(reservation.estado)}
          </div>

          <div class="reservation-dates">
            <span><strong>Inicio:</strong> ${formatDate(reservation.fechaInicio)}</span>
            <span><strong>Fin:</strong> ${formatDate(reservation.fechaFin)}</span>
            <span><strong>Creada:</strong> ${formatDateTime(reservation.creadaEn)}</span>
          </div>
        </header>

        <div class="info-grid">
          <div class="info-item">
            <strong>Unidad asignada</strong>
            <p>${reservation.unidadCodigo ? escapeHTML(reservation.unidadCodigo) : "Sin unidad asignada todavía"}</p>
          </div>

          <div class="info-item">
            <strong>Normas</strong>
            <p>${reservation.normasAceptadas ? "Aceptadas" : "No consta aceptación"}</p>
          </div>

          ${reservation.comentarioUsuario ? `
            <div class="info-item">
              <strong>Tu comentario</strong>
              <p>${escapeHTML(reservation.comentarioUsuario)}</p>
            </div>
          ` : ""}

          ${reservation.notasAdmin ? `
            <div class="info-item">
              <strong>Notas del club</strong>
              <p>${escapeHTML(reservation.notasAdmin)}</p>
            </div>
          ` : ""}
        </div>

        ${renderSpecialStateNotice(reservation)}
        ${renderTimeline(reservation)}
        ${renderReservationActions(reservation)}
      </div>
    </article>
  `;
}

function renderSpecialStateNotice(reservation) {
  if (reservation.estado === "rechazada") {
    return `
      <div class="notice notice-rejected">
        <p><strong>Solicitud rechazada.</strong> ${escapeHTML(reservation.motivoRechazo || "No se ha indicado motivo de rechazo.")}</p>
      </div>
    `;
  }

  if (reservation.estado === "incidencia") {
    return `
      <div class="notice notice-incidence">
        <p><strong>Reserva con incidencia.</strong> Revisa las notas del club o contacta con administración.</p>
      </div>
    `;
  }

  if (reservation.estado === "vencida") {
    return `
      <div class="notice notice-expired">
        <p><strong>Reserva vencida.</strong> Esta solicitud ya no está activa.</p>
      </div>
    `;
  }

  return "";
}

function renderTimeline(reservation) {
  const items = [
    { label: "Solicitud creada", value: reservation.creadaEn, done: Boolean(reservation.creadaEn) },
    { label: "Aprobada", value: reservation.aprobadaEn, done: Boolean(reservation.aprobadaEn) || ["aprobada", "recogida", "devuelta"].includes(reservation.estado) },
    { label: "Recogida", value: reservation.recogidaEn, done: Boolean(reservation.recogidaEn) || ["recogida", "devuelta"].includes(reservation.estado) },
    { label: "Devuelta", value: reservation.devueltaEn, done: Boolean(reservation.devueltaEn) || reservation.estado === "devuelta" }
  ];

  return `
    <section class="timeline" aria-label="Historial de la reserva">
      <h4>Historial</h4>
      <ul class="timeline-list">
        ${items.map((item) => `
          <li class="timeline-item ${item.done ? "done" : ""}">
            <span class="timeline-dot" aria-hidden="true"></span>
            <span class="timeline-text">
              <strong>${escapeHTML(item.label)}</strong>
              <span>${formatDateTime(item.value) || "Pendiente"}</span>
            </span>
          </li>
        `).join("")}
      </ul>
    </section>
  `;
}

function renderReservationActions(reservation) {
  if (reservation.estado === "aprobada") {
    return `
      <div class="card-actions">
        <button class="btn btn-primary" type="button" data-action="open-pickup-modal" data-reservation-id="${escapeHTML(reservation.id)}">
          Recoger material
        </button>
        <p class="empty-inline">Puedes marcar la recogida cuando tengas el material.</p>
      </div>
    `;
  }

  if (reservation.estado === "recogida") {
    return `
      <div class="card-actions">
        <button class="btn btn-primary" type="button" data-action="open-return-modal" data-reservation-id="${escapeHTML(reservation.id)}">
          Devolver material
        </button>
        <p class="empty-inline">Marca la devolución cuando entregues el material al club.</p>
      </div>
    `;
  }

  return "";
}

function getStatusBadge(status) {
  const labels = {
    pendiente: "Pendiente",
    aprobada: "Aprobada",
    rechazada: "Rechazada",
    cancelada: "Cancelada",
    recogida: "Recogida",
    devuelta: "Devuelta",
    incidencia: "Incidencia",
    vencida: "Vencida"
  };

  const classes = {
    pendiente: "badge-warning",
    aprobada: "badge-teal",
    rechazada: "badge-error",
    cancelada: "badge-muted",
    recogida: "badge-blue",
    devuelta: "badge-success",
    incidencia: "badge-orange",
    vencida: "badge-dark"
  };

  return `<span class="badge ${classes[status] || "badge-muted"}">${escapeHTML(labels[status] || status || "Sin estado")}</span>`;
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
            <p>Actualiza tus datos de contacto.</p>
          </div>
          <button class="btn btn-ghost" type="button" data-action="close-profile" aria-label="Cerrar">✕</button>
        </header>

        <div class="modal-body">
          <form id="profile-form" class="form" novalidate>
            <div class="form-row">
              <label for="profile-name">Nombre</label>
              <input id="profile-name" name="nombre" class="input" type="text" autocomplete="name" required value="${escapeHTML(profile.nombre || "")}" />
            </div>

            <div class="form-row">
              <label for="profile-email">Email</label>
              <input id="profile-email" name="email" class="input" type="email" value="${escapeHTML(email)}" disabled />
              <p class="input-hint">El email se gestiona desde Firebase Authentication.</p>
            </div>

            <div class="form-row">
              <label for="profile-phone">Teléfono</label>
              <input id="profile-phone" name="telefono" class="input" type="tel" autocomplete="tel" placeholder="600000000" value="${escapeHTML(profile.telefono || "")}" />
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

function renderActionModal() {
  const reservation = state.reservations.find((item) => item.id === state.actionModal?.reservationId);
  if (!reservation) return "";

  const isPickup = state.actionModal.type === "pickup";
  const title = isPickup ? "Confirmar recogida" : "Confirmar devolución";
  const formId = isPickup ? "pickup-form" : "return-form";
  const fileLabel = isPickup ? "Foto del material (opcional)" : "Foto del material devuelto (opcional)";
  const textareaLabel = isPickup ? "Observaciones" : "Observaciones de devolución";
  const buttonText = isPickup ? "Confirmar recogida" : "Confirmar devolución";

  return `
    <div class="modal-backdrop" data-action="close-action-modal">
      <section
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-title"
        onclick="event.stopPropagation()"
      >
        <header class="modal-header">
          <div>
            <h3 id="action-title">${title}</h3>
            <p>${escapeHTML(reservation.materialName || "Material del club")}</p>
          </div>
          <button class="btn btn-ghost" type="button" data-action="close-action-modal" aria-label="Cerrar">✕</button>
        </header>

        <div class="modal-body">
          <form id="${formId}" class="form" data-reservation-id="${escapeHTML(reservation.id)}" novalidate>
            <p class="input-hint">
              Puedes adjuntar una foto como parte del flujo, pero todavía no se sube ni se guarda en Storage.
              La acción continuará aunque no selecciones ninguna imagen.
            </p>

            <div class="form-row">
              <label for="action-photo">${fileLabel}</label>
              <input
                id="action-photo"
                name="photo"
                class="input"
                type="file"
                accept="image/*"
                data-file-preview="#selected-file-name"
              />
              <p id="selected-file-name" class="file-name">Ningún archivo seleccionado</p>
            </div>

            <div class="form-row">
              <label for="action-notes">${textareaLabel}</label>
              <textarea
                id="action-notes"
                name="observaciones"
                class="textarea"
                placeholder="Opcional. Ej.: entregado sin incidencias, revisar una correa, etc."
              ></textarea>
            </div>

            <p class="input-hint">
              Punto de integración futuro: aquí se subiría la imagen a Firebase Storage y se guardaría la URL o path en la reserva.
            </p>

            <p class="error-text" role="alert"></p>

            <div class="form-actions">
              <button class="btn btn-primary" type="submit">${buttonText}</button>
              <button class="btn btn-secondary" type="button" data-action="close-action-modal">Cancelar</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

/* =========================================================
   Acciones sobre reservas
   ========================================================= */

function openPickupModal(reservationId) {
  state.actionModal = { type: "pickup", reservationId };
  renderShell();
}

function openReturnModal(reservationId) {
  state.actionModal = { type: "return", reservationId };
  renderShell();
}

async function confirmPickup(form) {
  const reservationId = form.dataset.reservationId;
  const errorBox = form.querySelector(".error-text");
  const submitButton = form.querySelector("button[type='submit']");
  setFormError(errorBox, "");
  submitButton.disabled = true;

  try {
    const reservation = state.reservations.find((item) => item.id === reservationId);
    if (!reservation) throw new Error("No se ha encontrado la reserva.");
    if (reservation.estado !== "aprobada") throw new Error("Solo puedes recoger una reserva aprobada.");

    const formData = new FormData(form);
    const observaciones = String(formData.get("observaciones") || "").trim();

    // La foto seleccionada no se sube todavía. En el futuro se conectaría aquí Firebase Storage.
    await updateDoc(doc(db, "reservas", reservationId), {
      estado: "recogida",
      recogidaEn: serverTimestamp(),
      observacionesRecogidaUsuario: observaciones,
      actualizadaEn: serverTimestamp()
    });

    state.actionModal = null;
    showToast("success", "Recogida confirmada", "La reserva se ha marcado como recogida.");
    await loadUserReservations();
  } catch (error) {
    console.error(error);
    setFormError(errorBox, getFriendlyError(error));
  } finally {
    submitButton.disabled = false;
  }
}

async function confirmReturn(form) {
  const reservationId = form.dataset.reservationId;
  const errorBox = form.querySelector(".error-text");
  const submitButton = form.querySelector("button[type='submit']");
  setFormError(errorBox, "");
  submitButton.disabled = true;

  try {
    const reservation = state.reservations.find((item) => item.id === reservationId);
    if (!reservation) throw new Error("No se ha encontrado la reserva.");
    if (reservation.estado !== "recogida") throw new Error("Solo puedes devolver una reserva recogida.");

    const formData = new FormData(form);
    const observaciones = String(formData.get("observaciones") || "").trim();

    // La foto seleccionada no se sube todavía. En el futuro se conectaría aquí Firebase Storage.
    await updateDoc(doc(db, "reservas", reservationId), {
      estado: "devuelta",
      devueltaEn: serverTimestamp(),
      observacionesDevolucionUsuario: observaciones,
      actualizadaEn: serverTimestamp()
    });

    state.actionModal = null;
    showToast("success", "Devolución confirmada", "La reserva se ha marcado como devuelta.");
    await loadUserReservations();
  } catch (error) {
    console.error(error);
    setFormError(errorBox, getFriendlyError(error));
  } finally {
    submitButton.disabled = false;
  }
}

/* =========================================================
   Utilidades
   ========================================================= */

function getReservationSummary() {
  const reservations = state.reservations || [];
  return {
    total: reservations.length,
    active: reservations.filter((item) => ACTIVE_STATES.includes(item.estado)).length,
    pending: reservations.filter((item) => item.estado === "pendiente").length,
    picked: reservations.filter((item) => item.estado === "recogida").length
  };
}

function setLoading(value) {
  state.isLoading = value;
  if (document.getElementById("reservations-list")) {
    renderReservations();
  }
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

function formatDateTime(value) {
  const date = timestampToDate(value);
  if (!date) return "";

  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function timestampToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function getTimestampMillis(value) {
  const date = timestampToDate(value);
  return date ? date.getTime() : 0;
}

function getStartOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

function getNameFromEmail(email) {
  const value = String(email || "").trim();
  if (!value.includes("@")) return "Socio";
  return value.split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function setFormError(element, message) {
  if (!element) return;
  element.textContent = message || "";
  element.classList.toggle("visible", Boolean(message));
}

function showToast(type, title, message = "") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <strong>${escapeHTML(title)}</strong>
    ${message ? `<p>${escapeHTML(message)}</p>` : ""}
  `;

  els.toastRoot.appendChild(toast);

  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    toast.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    window.setTimeout(() => toast.remove(), 220);
  }, 4200);
}

function getFriendlyError(error) {
  const code = error?.code || "";
  const message = error?.message || "";

  if (code === "permission-denied" || message.includes("Missing or insufficient permissions")) {
    return "No tienes permisos para realizar esta acción. Revisa las reglas de Firestore.";
  }

  if (code === "failed-precondition" || message.includes("index")) {
    return "Firestore necesita un índice compuesto para esta consulta.";
  }

  if (code === "unavailable") {
    return "Firebase no está disponible temporalmente. Inténtalo de nuevo.";
  }

  return message || "Ha ocurrido un error inesperado.";
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
