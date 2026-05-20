import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-analytics.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-storage.js";

/**
 * Seguridad importante:
 * Esta comprobación de rol en frontend mejora la experiencia, pero NO protege la base de datos.
 * La protección real debe estar en Firestore Rules y Storage Rules usando usuarios/{uid}.rol == "admin".
 */

const firebaseConfig = {
  apiKey: "AIzaSyDPgjRW1BBWPqhQalEYNzcQmT5Qs1W4X5I",
  authDomain: "kpicos.firebaseapp.com",
  projectId: "kpicos",
  storageBucket: "kpicos.firebasestorage.app",
  messagingSenderId: "162214496002",
  appId: "1:162214496002:web:3b642b037b556a3496a41b",
  measurementId: "G-T8V2G5QCPB"
};

const RESERVATION_STATES = [
  "pendiente",
  "aprobada",
  "rechazada",
  "cancelada",
  "recogida",
  "devuelta",
  "incidencia",
  "vencida"
];

const UNIT_STATES = [
  "disponible",
  "mantenimiento",
  "retirado",
  "perdido"
];

const statePriority = {
  pendiente: 0,
  aprobada: 1,
  recogida: 2,
  incidencia: 3,
  vencida: 4,
  rechazada: 5,
  cancelada: 6,
  devuelta: 7
};

let app;
let analytics;
let auth;
let db;
let storage;

let currentUser = null;
let currentAdminProfile = null;

let materials = [];
let units = [];
let reservations = [];
let materialImageUrlCache = new Map();
let editingMaterialId = null;

const els = {
  app: document.querySelector("#app"),
  toastRoot: document.querySelector("#toast-root")
};

document.addEventListener("DOMContentLoaded", () => {
  initFirebase();
  setupAuthListeners();
});

function initFirebase() {
  app = initializeApp(firebaseConfig);
  analytics = getAnalytics(app);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
}

function setupAuthListeners() {
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;

    if (!user) {
      currentAdminProfile = null;
      renderLogin();
      return;
    }

    await checkAdminAccess(user);
  });
}

function renderLogin() {
  els.app.innerHTML = `
    <section class="screen-center">
      <article class="auth-card">
        <div class="auth-brand">
          <span class="kicker">Administración · 100K Picos</span>
          <h1>Acceso administrador</h1>
          <p>Inicia sesión con una cuenta autorizada para gestionar material, unidades y solicitudes.</p>
        </div>

        <form id="login-form" class="form-stack" novalidate>
          <div id="auth-error" class="error-box hidden"></div>

          <div class="field">
            <label for="email">Email</label>
            <input id="email" class="input" type="email" autocomplete="email" required />
          </div>

          <div class="field">
            <label for="password">Contraseña</label>
            <input id="password" class="input" type="password" autocomplete="current-password" required />
          </div>

          <button class="btn btn-primary" type="submit">Entrar</button>

          <p class="help">
            Las cuentas de administrador deben existir en Firebase Auth y tener <strong>rol: "admin"</strong>
            en <strong>usuarios/{uid}</strong>.
          </p>
        </form>
      </article>
    </section>
  `;

  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = document.querySelector("#auth-error");
    errorBox.classList.add("hidden");
    errorBox.textContent = "";

    const email = document.querySelector("#email").value.trim();
    const password = document.querySelector("#password").value;

    if (!email || !password) {
      showInlineError(errorBox, "Introduce email y contraseña.");
      return;
    }

    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      showInlineError(errorBox, getAuthErrorMessage(error));
    }
  });
}

async function checkAdminAccess(user) {
  setLoading("Comprobando permisos…");

  try {
    const userRef = doc(db, "usuarios", user.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists() || userSnap.data().rol !== "admin") {
      renderAccessDenied(user);
      return;
    }

    currentAdminProfile = {
      uid: user.uid,
      email: user.email || "",
      nombre: userSnap.data().nombre || user.displayName || user.email || "Administrador",
      ...userSnap.data()
    };

    renderAdminPanel();
    await Promise.all([
      loadMaterials(),
      loadUnits(),
      loadReservations()
    ]);
  } catch (error) {
    console.error(error);
    renderAccessDenied(user, "No se han podido comprobar los permisos de administrador.");
  }
}

function renderAccessDenied(user, message = "Tu cuenta no tiene permisos de administración.") {
  els.app.innerHTML = `
    <section class="screen-center">
      <article class="denied-card">
        <span class="kicker">Acceso denegado</span>
        <h1>No autorizado</h1>
        <p>${escapeHtml(message)}</p>
        <p class="help" style="margin-top: 12px;">
          Usuario actual: <strong>${escapeHtml(user.email || "Sin email")}</strong>
        </p>
        <div class="auth-actions">
          <button id="logout-denied" class="btn btn-secondary" type="button">Cerrar sesión</button>
        </div>
      </article>
    </section>
  `;

  document.querySelector("#logout-denied").addEventListener("click", () => signOut(auth));
}

function renderAdminPanel() {
  els.app.innerHTML = `
    <div class="admin-layout">
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand">
            <div class="brand-mark">100</div>
            <div class="brand-text">
              <span class="brand-title">100K Picos</span>
              <span class="brand-subtitle">Administración de reservas</span>
            </div>
          </div>

          <div class="topbar-actions">
            <span class="admin-name">${escapeHtml(currentAdminProfile?.nombre || "Admin")}</span>
            <button id="logout-btn" class="btn btn-secondary btn-small" type="button">Cerrar sesión</button>
          </div>
        </div>
      </header>

      <main class="main">
        <section class="hero">
          <span class="kicker">Panel de administración</span>
          <h1>Reservas de material</h1>
          <p>Gestiona solicitudes, catálogo de material y unidades físicas del club. La aprobación de reservas sigue siendo manual.</p>
        </section>

        <nav class="tabs" aria-label="Secciones de administración">
          <button class="tab-btn" data-tab="reservations" aria-selected="true" type="button">Solicitudes</button>
          <button class="tab-btn" data-tab="materials" aria-selected="false" type="button">Material</button>
          <button class="tab-btn" data-tab="units" aria-selected="false" type="button">Unidades</button>
        </nav>

        <section id="tab-reservations" class="section active"></section>
        <section id="tab-materials" class="section"></section>
        <section id="tab-units" class="section"></section>
      </main>
    </div>
  `;

  document.querySelector("#logout-btn").addEventListener("click", () => signOut(auth));
  setupTabs();
  renderReservations();
  renderMaterials();
  renderUnits();
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;

      document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
      });

      document.querySelectorAll(".section").forEach((section) => {
        section.classList.remove("active");
      });

      document.querySelector(`#tab-${tab}`).classList.add("active");
    });
  });
}

async function loadMaterials() {
  try {
    const snapshot = await getDocs(collection(db, "material"));
    materials = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => {
        const orderA = Number.isFinite(Number(a.orden)) ? Number(a.orden) : 999999;
        const orderB = Number.isFinite(Number(b.orden)) ? Number(b.orden) : 999999;
        if (orderA !== orderB) return orderA - orderB;
        return String(a.nombre || "").localeCompare(String(b.nombre || ""), "es", { sensitivity: "base" });
      });

    await hydrateMaterialImages();
    renderMaterials();
    renderUnits();
    renderReservations();
  } catch (error) {
    console.error(error);
    showToast("Error al cargar material.", "error");
  }
}

async function hydrateMaterialImages() {
  await Promise.all(materials.map(async (material) => {
    if (!material.imagenPrincipalPath || materialImageUrlCache.has(material.id)) return;

    try {
      const url = await getDownloadURL(ref(storage, material.imagenPrincipalPath));
      materialImageUrlCache.set(material.id, url);
    } catch {
      materialImageUrlCache.set(material.id, "");
    }
  }));
}

function renderMaterials() {
  const root = document.querySelector("#tab-materials");
  if (!root) return;

  root.innerHTML = `
    <article class="card">
      <h2 class="section-title">${editingMaterialId ? "Editar material" : "Añadir material"}</h2>
      <p class="section-description">${editingMaterialId ? "Modifica el material seleccionado. El ID del documento no se cambia aunque edites el nombre." : "Crea un nuevo elemento del catálogo. Después podrás añadir sus unidades físicas en la pestaña “Unidades”."}</p>

      <form id="material-form" class="form-stack" novalidate>
        <div class="form-grid two">
          <div class="field">
            <label for="mat-nombre">Nombre</label>
            <input id="mat-nombre" class="input" required />
          </div>

          <div class="field">
            <label for="mat-categoria">Categoría</label>
            <input id="mat-categoria" class="input" required />
          </div>
        </div>

        <div class="field">
          <label for="mat-descripcion">Descripción</label>
          <textarea id="mat-descripcion" class="textarea"></textarea>
        </div>

        <div class="field">
          <label for="mat-normas">Normas de uso</label>
          <textarea id="mat-normas" class="textarea"></textarea>
        </div>

        <div class="form-grid two">
          <div class="field">
            <label for="mat-fianza">Fianza (€)</label>
            <input id="mat-fianza" class="input" type="number" min="0" step="0.01" value="0" />
          </div>

          <div class="field">
            <label for="mat-orden">Orden</label>
            <input id="mat-orden" class="input" type="number" step="1" value="100" />
          </div>
        </div>

        <div class="form-grid two">
          <label class="field inline">
            <input id="mat-visible" class="input" type="checkbox" checked />
            <span>Visible para socios</span>
          </label>

          <label class="field inline">
            <input id="mat-activo" class="input" type="checkbox" checked />
            <span>Activo</span>
          </label>
        </div>

        <div class="field">
          <label for="mat-imagen">Imagen principal</label>
          <input id="mat-imagen" class="input" type="file" accept="image/*" />
          <span class="help">Se subirá a Storage como material/{id}/principal.jpg.</span>
        </div>

        <div class="btn-row">
          <button class="btn btn-primary" type="submit">${editingMaterialId ? "Guardar cambios" : "Crear material"}</button>
          ${editingMaterialId ? `<button id="cancel-material-edit" class="btn btn-secondary" type="button">Cancelar edición</button>` : ""}
        </div>
      </form>
    </article>

    <article class="card">
      <div class="material-head">
        <div>
          <h2 class="section-title">Material existente</h2>
          <p class="section-description">Edita campos básicos, visibilidad y estado activo. No se realiza borrado físico.</p>
        </div>
        <button id="refresh-materials" class="btn btn-secondary btn-small" type="button">Actualizar</button>
      </div>

      <div id="materials-list" class="cards-grid material-grid"></div>
    </article>
  `;

  document.querySelector("#material-form").addEventListener("submit", createMaterial);
  document.querySelector("#refresh-materials").addEventListener("click", loadMaterials);

  const cancelEditBtn = document.querySelector("#cancel-material-edit");
  if (cancelEditBtn) {
    cancelEditBtn.addEventListener("click", () => {
      editingMaterialId = null;
      renderMaterials();
    });
  }

  const list = document.querySelector("#materials-list");

  if (!materials.length) {
    list.innerHTML = `
      <div class="empty-state">
        <strong>No hay material creado.</strong>
        Añade el primer elemento del catálogo desde el formulario superior.
      </div>
    `;
    return;
  }

  list.innerHTML = materials.map((material) => renderMaterialCard(material)).join("");

  list.querySelectorAll("[data-action='toggle-material']").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.id;
      const field = button.dataset.field;
      const material = materials.find((item) => item.id === id);
      if (!material) return;

      await updateMaterial(id, {
        [field]: !Boolean(material[field]),
        actualizadoEn: serverTimestamp()
      });
    });
  });

  list.querySelectorAll("[data-action='edit-material']").forEach((button) => {
    button.addEventListener("click", () => {
      const material = materials.find((item) => item.id === button.dataset.id);
      if (material) startMaterialEdit(material);
    });
  });
}

function renderMaterialCard(material) {
  const unitCount = units.filter((unit) => unit.materialId === material.id && unit.activo !== false).length;
  const availableCount = units.filter((unit) =>
    unit.materialId === material.id &&
    unit.activo !== false &&
    unit.estado === "disponible"
  ).length;
  const imageUrl = materialImageUrlCache.get(material.id);

  return `
    <article class="material-card card card-hover">
      ${imageUrl
        ? `<img class="material-thumb" src="${escapeAttr(imageUrl)}" alt="${escapeAttr(material.nombre || "Material")}" loading="lazy" />`
        : `<div class="placeholder-img">Sin imagen</div>`
      }

      <div class="material-head">
        <div>
          <h3>${escapeHtml(material.nombre || "Sin nombre")}</h3>
          <div class="meta">
            <span>${escapeHtml(material.categoria || "Sin categoría")}</span>
            <span>Orden ${escapeHtml(String(material.orden ?? "-"))}</span>
          </div>
        </div>
        <span class="badge ${material.activo === false ? "badge-inactive" : "badge-disponible"}">
          ${material.activo === false ? "Inactivo" : "Activo"}
        </span>
      </div>

      ${material.descripcion ? `<p class="description">${escapeHtml(material.descripcion)}</p>` : ""}

      <div class="meta">
        <span class="badge ${material.visible === false ? "badge-cancelada" : "badge-aprobada"}">
          ${material.visible === false ? "Oculto" : "Visible"}
        </span>
        <span>${unitCount} unidades</span>
        <span>${availableCount} disponibles</span>
        ${Number(material.fianza || 0) > 0 ? `<span>Fianza: ${formatMoney(material.fianza)}</span>` : ""}
      </div>

      <div class="btn-row">
        <button class="btn btn-secondary btn-small" data-action="edit-material" data-id="${escapeAttr(material.id)}" type="button">Editar</button>
        <button class="btn btn-soft btn-small" data-action="toggle-material" data-field="visible" data-id="${escapeAttr(material.id)}" type="button">
          ${material.visible === false ? "Mostrar" : "Ocultar"}
        </button>
        <button class="btn btn-soft btn-small" data-action="toggle-material" data-field="activo" data-id="${escapeAttr(material.id)}" type="button">
          ${material.activo === false ? "Activar" : "Desactivar"}
        </button>
      </div>
    </article>
  `;
}

async function createMaterial(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const nombre = form.querySelector("#mat-nombre").value.trim();
  const categoria = form.querySelector("#mat-categoria").value.trim();
  const descripcion = form.querySelector("#mat-descripcion").value.trim();
  const normasUso = form.querySelector("#mat-normas").value.trim();
  const fianza = parseFloat(form.querySelector("#mat-fianza").value || "0");
  const orden = parseInt(form.querySelector("#mat-orden").value || "100", 10);
  const visible = form.querySelector("#mat-visible").checked;
  const activo = form.querySelector("#mat-activo").checked;
  const imageFile = form.querySelector("#mat-imagen").files[0];

  if (!nombre || !categoria) {
    showToast("Nombre y categoría son obligatorios.", "error");
    return;
  }

  try {
    // Modo edición: se mantiene el ID original del documento para no romper unidades/reservas existentes.
    if (editingMaterialId) {
      const existingMaterial = materials.find((item) => item.id === editingMaterialId);
      if (!existingMaterial) {
        showToast("No se ha encontrado el material que estás editando.", "error");
        editingMaterialId = null;
        renderMaterials();
        return;
      }

      let imagenPrincipalPath = existingMaterial.imagenPrincipalPath || "";
      if (imageFile) {
        imagenPrincipalPath = await uploadMaterialImage(editingMaterialId, imageFile);
        materialImageUrlCache.delete(editingMaterialId);
      }

      await updateMaterial(editingMaterialId, {
        nombre,
        categoria,
        descripcion,
        normasUso,
        fianza: Number.isFinite(fianza) ? fianza : 0,
        orden: Number.isFinite(orden) ? orden : 100,
        visible,
        activo,
        imagenPrincipalPath,
        actualizadoEn: serverTimestamp()
      }, { reload: false });

      editingMaterialId = null;
      resetMaterialForm(form);
      showToast("Material actualizado correctamente.", "success");
      await loadMaterials();
      return;
    }

    // Modo creación: el ID legible se genera solo al crear el material.
    const materialId = slugify(nombre);
    if (!materialId) {
      showToast("No se ha podido generar un ID válido para el material.", "error");
      return;
    }

    const existingSnap = await getDoc(doc(db, "material", materialId));
    if (existingSnap.exists()) {
      showToast(`Ya existe un material con ID ${materialId}. Cambia el nombre o edita el existente.`, "error");
      return;
    }

    const imagenPrincipalPath = imageFile
      ? await uploadMaterialImage(materialId, imageFile)
      : "";

    await setDoc(doc(db, "material", materialId), {
      nombre,
      categoria,
      descripcion,
      imagenPrincipalPath,
      normasUso,
      fianza: Number.isFinite(fianza) ? fianza : 0,
      activo,
      visible,
      orden: Number.isFinite(orden) ? orden : 100,
      creadoEn: serverTimestamp(),
      actualizadoEn: serverTimestamp()
    });

    resetMaterialForm(form);
    showToast("Material creado correctamente.", "success");
    await loadMaterials();
  } catch (error) {
    console.error(error);
    showToast(editingMaterialId ? "Error al actualizar el material." : "Error al crear el material.", "error");
  }
}

function startMaterialEdit(material) {
  editingMaterialId = material.id;
  renderMaterials();

  const form = document.querySelector("#material-form");
  if (!form) return;

  form.querySelector("#mat-nombre").value = material.nombre || "";
  form.querySelector("#mat-categoria").value = material.categoria || "";
  form.querySelector("#mat-descripcion").value = material.descripcion || "";
  form.querySelector("#mat-normas").value = material.normasUso || "";
  form.querySelector("#mat-fianza").value = String(material.fianza ?? 0);
  form.querySelector("#mat-orden").value = String(material.orden ?? 100);
  form.querySelector("#mat-visible").checked = material.visible !== false;
  form.querySelector("#mat-activo").checked = material.activo !== false;
  form.querySelector("#mat-imagen").value = "";

  form.scrollIntoView({ behavior: "smooth", block: "start" });
  showToast(`Editando ${material.nombre || material.id}.`, "success");
}

function resetMaterialForm(form) {
  form.reset();
  form.querySelector("#mat-visible").checked = true;
  form.querySelector("#mat-activo").checked = true;
  form.querySelector("#mat-fianza").value = "0";
  form.querySelector("#mat-orden").value = "100";
}

async function updateMaterial(materialId, payload, options = {}) {
  try {
    await updateDoc(doc(db, "material", materialId), payload);
    if (options.silent !== true) showToast("Material actualizado.", "success");
    if (options.reload !== false) await loadMaterials();
  } catch (error) {
    console.error(error);
    showToast("Error al actualizar el material.", "error");
  }
}

async function uploadMaterialImage(materialId, file) {
  const imagePath = `material/${materialId}/principal.jpg`;
  const storageRef = ref(storage, imagePath);

  await uploadBytes(storageRef, file, {
    contentType: file.type || "image/jpeg"
  });

  return imagePath;
}

function openMaterialEditModal(material) {
  const modal = createModal(`
    <form id="edit-material-form" class="form-stack" novalidate>
      <div class="form-grid two">
        <div class="field">
          <label for="edit-mat-nombre">Nombre</label>
          <input id="edit-mat-nombre" class="input" value="${escapeAttr(material.nombre || "")}" required />
        </div>

        <div class="field">
          <label for="edit-mat-categoria">Categoría</label>
          <input id="edit-mat-categoria" class="input" value="${escapeAttr(material.categoria || "")}" required />
        </div>
      </div>

      <div class="field">
        <label for="edit-mat-descripcion">Descripción</label>
        <textarea id="edit-mat-descripcion" class="textarea">${escapeHtml(material.descripcion || "")}</textarea>
      </div>

      <div class="field">
        <label for="edit-mat-normas">Normas de uso</label>
        <textarea id="edit-mat-normas" class="textarea">${escapeHtml(material.normasUso || "")}</textarea>
      </div>

      <div class="form-grid two">
        <div class="field">
          <label for="edit-mat-fianza">Fianza (€)</label>
          <input id="edit-mat-fianza" class="input" type="number" min="0" step="0.01" value="${escapeAttr(String(material.fianza ?? 0))}" />
        </div>

        <div class="field">
          <label for="edit-mat-orden">Orden</label>
          <input id="edit-mat-orden" class="input" type="number" step="1" value="${escapeAttr(String(material.orden ?? 100))}" />
        </div>
      </div>

      <div class="form-grid two">
        <label class="field inline">
          <input id="edit-mat-visible" class="input" type="checkbox" ${material.visible !== false ? "checked" : ""} />
          <span>Visible</span>
        </label>

        <label class="field inline">
          <input id="edit-mat-activo" class="input" type="checkbox" ${material.activo !== false ? "checked" : ""} />
          <span>Activo</span>
        </label>
      </div>

      <div class="field">
        <label for="edit-mat-imagen">Nueva imagen principal, opcional</label>
        <input id="edit-mat-imagen" class="input" type="file" accept="image/*" />
      </div>

      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Guardar cambios</button>
        <button class="btn btn-secondary" data-close-modal type="button">Cancelar</button>
      </div>
    </form>
  `, `Editar ${material.nombre || "material"}`);

  const form = modal.querySelector("#edit-material-form");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const imageFile = form.querySelector("#edit-mat-imagen").files[0];

    try {
      let imagenPrincipalPath = material.imagenPrincipalPath || "";
      if (imageFile) {
        imagenPrincipalPath = await uploadMaterialImage(material.id, imageFile);
        materialImageUrlCache.delete(material.id);
      }

      await updateMaterial(material.id, {
        nombre: form.querySelector("#edit-mat-nombre").value.trim(),
        categoria: form.querySelector("#edit-mat-categoria").value.trim(),
        descripcion: form.querySelector("#edit-mat-descripcion").value.trim(),
        normasUso: form.querySelector("#edit-mat-normas").value.trim(),
        fianza: parseFloat(form.querySelector("#edit-mat-fianza").value || "0") || 0,
        orden: parseInt(form.querySelector("#edit-mat-orden").value || "100", 10) || 100,
        visible: form.querySelector("#edit-mat-visible").checked,
        activo: form.querySelector("#edit-mat-activo").checked,
        imagenPrincipalPath,
        actualizadoEn: serverTimestamp()
      });

      closeModal(modal);
    } catch (error) {
      console.error(error);
      showToast("Error al guardar cambios.", "error");
    }
  });
}

async function loadUnits() {
  try {
    const snapshot = await getDocs(collection(db, "unidades_material"));
    units = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => {
        const materialCompare = String(a.materialNombre || "").localeCompare(String(b.materialNombre || ""), "es", { sensitivity: "base" });
        if (materialCompare !== 0) return materialCompare;
        return String(a.codigoInterno || "").localeCompare(String(b.codigoInterno || ""), "es", { numeric: true, sensitivity: "base" });
      });

    renderUnits();
    renderMaterials();
    renderReservations();
  } catch (error) {
    console.error(error);
    showToast("Error al cargar unidades.", "error");
  }
}

function renderUnits() {
  const root = document.querySelector("#tab-units");
  if (!root) return;

  root.innerHTML = `
    <article class="card">
      <h2 class="section-title">Añadir unidad</h2>
      <p class="section-description">Cada documento representa una unidad física real: un par de crampones, un casco, un piolet, etc.</p>

      <form id="unit-form" class="form-stack" novalidate>
        <div class="form-grid two">
          <div class="field">
            <label for="unit-material">Material</label>
            <select id="unit-material" class="select" required>
              <option value="">Selecciona material</option>
              ${materials.map((material) => `<option value="${escapeAttr(material.id)}">${escapeHtml(material.nombre || material.id)}</option>`).join("")}
            </select>
          </div>

          <div class="field">
            <label for="unit-code">Código interno</label>
            <input id="unit-code" class="input" placeholder="CR-01" required />
          </div>
        </div>

        <div class="form-grid two">
          <div class="field">
            <label for="unit-state">Estado</label>
            <select id="unit-state" class="select">
              ${UNIT_STATES.map((item) => `<option value="${item}">${capitalize(item)}</option>`).join("")}
            </select>
          </div>

          <label class="field inline">
            <input id="unit-active" class="input" type="checkbox" checked />
            <span>Activo</span>
          </label>
        </div>

        <div class="field">
          <label for="unit-notes">Notas internas</label>
          <textarea id="unit-notes" class="textarea"></textarea>
        </div>

        <button class="btn btn-primary" type="submit">Añadir unidad</button>
      </form>
    </article>

    <article class="card">
      <div class="material-head">
        <div>
          <h2 class="section-title">Unidades existentes</h2>
          <p class="section-description">Filtra por material y cambia estado o activo sin borrar documentos.</p>
        </div>
        <button id="refresh-units" class="btn btn-secondary btn-small" type="button">Actualizar</button>
      </div>

      <div class="toolbar-grid" style="margin-bottom: 14px;">
        <div class="field">
          <label for="unit-filter-material">Material</label>
          <select id="unit-filter-material" class="select">
            <option value="">Todos</option>
            ${materials.map((material) => `<option value="${escapeAttr(material.id)}">${escapeHtml(material.nombre || material.id)}</option>`).join("")}
          </select>
        </div>

        <div class="field">
          <label for="unit-filter-state">Estado</label>
          <select id="unit-filter-state" class="select">
            <option value="">Todos</option>
            ${UNIT_STATES.map((item) => `<option value="${item}">${capitalize(item)}</option>`).join("")}
          </select>
        </div>

        <div class="field">
          <label for="unit-search">Buscar</label>
          <input id="unit-search" class="input" placeholder="Código, material, notas…" />
        </div>
      </div>

      <div id="units-list" class="cards-grid unit-grid"></div>
    </article>
  `;

  document.querySelector("#unit-form").addEventListener("submit", createUnit);
  document.querySelector("#refresh-units").addEventListener("click", loadUnits);

  ["#unit-filter-material", "#unit-filter-state", "#unit-search"].forEach((selector) => {
    document.querySelector(selector).addEventListener("input", renderFilteredUnits);
  });

  renderFilteredUnits();
}

function renderFilteredUnits() {
  const list = document.querySelector("#units-list");
  if (!list) return;

  const materialFilter = document.querySelector("#unit-filter-material")?.value || "";
  const stateFilter = document.querySelector("#unit-filter-state")?.value || "";
  const search = normalizeText(document.querySelector("#unit-search")?.value || "");

  const filtered = units.filter((unit) => {
    if (materialFilter && unit.materialId !== materialFilter) return false;
    if (stateFilter && unit.estado !== stateFilter) return false;

    if (search) {
      const haystack = normalizeText([
        unit.materialNombre,
        unit.codigoInterno,
        unit.estado,
        unit.notasInternas
      ].join(" "));
      if (!haystack.includes(search)) return false;
    }

    return true;
  });

  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty-state">
        <strong>No hay unidades con esos filtros.</strong>
        Añade unidades o cambia los filtros.
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map((unit) => renderUnitCard(unit)).join("");

  list.querySelectorAll("[data-action='update-unit-state']").forEach((select) => {
    select.addEventListener("change", async () => {
      await updateUnit(select.dataset.id, {
        estado: select.value,
        actualizadoEn: serverTimestamp()
      });
    });
  });

  list.querySelectorAll("[data-action='toggle-unit']").forEach((button) => {
    button.addEventListener("click", async () => {
      const unit = units.find((item) => item.id === button.dataset.id);
      if (!unit) return;

      await updateUnit(unit.id, {
        activo: !Boolean(unit.activo !== false),
        actualizadoEn: serverTimestamp()
      });
    });
  });

  list.querySelectorAll("[data-action='edit-unit-notes']").forEach((button) => {
    button.addEventListener("click", () => {
      const unit = units.find((item) => item.id === button.dataset.id);
      if (unit) openUnitNotesModal(unit);
    });
  });
}

function renderUnitCard(unit) {
  return `
    <article class="unit-card card card-hover">
      <div class="unit-head">
        <div>
          <h3>${escapeHtml(unit.codigoInterno || "Sin código")}</h3>
          <div class="meta">
            <span>${escapeHtml(unit.materialNombre || unit.materialId || "Sin material")}</span>
          </div>
        </div>
        <span class="badge badge-${escapeAttr(unit.estado || "cancelada")}">${escapeHtml(capitalize(unit.estado || "sin estado"))}</span>
      </div>

      ${unit.notasInternas ? `<p class="description">${escapeHtml(unit.notasInternas)}</p>` : ""}

      <div class="meta">
        <span class="badge ${unit.activo === false ? "badge-inactive" : "badge-disponible"}">
          ${unit.activo === false ? "Inactiva" : "Activa"}
        </span>
      </div>

      <div class="field">
        <label for="unit-state-${escapeAttr(unit.id)}">Cambiar estado</label>
        <select id="unit-state-${escapeAttr(unit.id)}" class="select" data-action="update-unit-state" data-id="${escapeAttr(unit.id)}">
          ${UNIT_STATES.map((item) => `<option value="${item}" ${unit.estado === item ? "selected" : ""}>${capitalize(item)}</option>`).join("")}
        </select>
      </div>

      <div class="btn-row">
        <button class="btn btn-secondary btn-small" data-action="edit-unit-notes" data-id="${escapeAttr(unit.id)}" type="button">Editar notas</button>
        <button class="btn btn-soft btn-small" data-action="toggle-unit" data-id="${escapeAttr(unit.id)}" type="button">
          ${unit.activo === false ? "Activar" : "Desactivar"}
        </button>
      </div>
    </article>
  `;
}

async function createUnit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const materialId = form.querySelector("#unit-material").value;
  const material = materials.find((item) => item.id === materialId);
  const codigoInterno = form.querySelector("#unit-code").value.trim();
  const estado = form.querySelector("#unit-state").value;
  const notasInternas = form.querySelector("#unit-notes").value.trim();
  const activo = form.querySelector("#unit-active").checked;

  if (!material || !codigoInterno) {
    showToast("Selecciona material e introduce un código interno.", "error");
    return;
  }

  try {
    await addDoc(collection(db, "unidades_material"), {
      materialId: material.id,
      materialNombre: material.nombre || material.id,
      codigoInterno,
      estado,
      notasInternas,
      activo,
      creadoEn: serverTimestamp(),
      actualizadoEn: serverTimestamp()
    });

    form.reset();
    form.querySelector("#unit-active").checked = true;
    showToast("Unidad añadida correctamente.", "success");
    await loadUnits();
  } catch (error) {
    console.error(error);
    showToast("Error al añadir la unidad.", "error");
  }
}

async function updateUnit(unitId, payload) {
  try {
    await updateDoc(doc(db, "unidades_material", unitId), payload);
    showToast("Unidad actualizada.", "success");
    await loadUnits();
  } catch (error) {
    console.error(error);
    showToast("Error al actualizar la unidad.", "error");
  }
}

function openUnitNotesModal(unit) {
  const modal = createModal(`
    <form id="unit-notes-form" class="form-stack">
      <div class="field">
        <label for="unit-notes-edit">Notas internas</label>
        <textarea id="unit-notes-edit" class="textarea">${escapeHtml(unit.notasInternas || "")}</textarea>
      </div>

      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Guardar notas</button>
        <button class="btn btn-secondary" data-close-modal type="button">Cancelar</button>
      </div>
    </form>
  `, `Notas · ${unit.codigoInterno || "Unidad"}`);

  modal.querySelector("#unit-notes-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await updateUnit(unit.id, {
      notasInternas: modal.querySelector("#unit-notes-edit").value.trim(),
      actualizadoEn: serverTimestamp()
    });
    closeModal(modal);
  });
}

async function loadReservations() {
  try {
    const snapshot = await getDocs(collection(db, "reservas"));
    reservations = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort(compareReservations);

    renderReservations();
  } catch (error) {
    console.error(error);
    showToast("Error al cargar solicitudes.", "error");
  }
}

function renderReservations() {
  const root = document.querySelector("#tab-reservations");
  if (!root) return;

  root.innerHTML = `
    <article class="card">
      <div class="material-head">
        <div>
          <h2 class="section-title">Solicitudes</h2>
          <p class="section-description">Revisa reservas, asigna unidad al aprobar y cambia estados manualmente.</p>
        </div>
        <button id="refresh-reservations" class="btn btn-secondary btn-small" type="button">Actualizar</button>
      </div>

      <div class="toolbar-grid">
        <div class="field">
          <label for="reservation-filter-state">Estado</label>
          <select id="reservation-filter-state" class="select">
            <option value="">Todos</option>
            ${RESERVATION_STATES.map((item) => `<option value="${item}">${capitalize(item)}</option>`).join("")}
          </select>
        </div>

        <div class="field">
          <label for="reservation-filter-material">Material</label>
          <select id="reservation-filter-material" class="select">
            <option value="">Todos</option>
            ${materials.map((material) => `<option value="${escapeAttr(material.id)}">${escapeHtml(material.nombre || material.id)}</option>`).join("")}
          </select>
        </div>

        <div class="field">
          <label for="reservation-filter-date">Fecha aproximada</label>
          <input id="reservation-filter-date" class="input" type="date" />
        </div>
      </div>

      <div class="field" style="margin-top: 10px;">
        <label for="reservation-search">Buscar</label>
        <input id="reservation-search" class="input" placeholder="Usuario, email, teléfono, material…" />
      </div>

      <div id="reservations-list" class="cards-grid reservation-grid" style="margin-top: 14px;"></div>
    </article>
  `;

  document.querySelector("#refresh-reservations").addEventListener("click", loadReservations);

  ["#reservation-filter-state", "#reservation-filter-material", "#reservation-filter-date", "#reservation-search"].forEach((selector) => {
    document.querySelector(selector).addEventListener("input", renderFilteredReservations);
  });

  renderFilteredReservations();
}

function renderFilteredReservations() {
  const list = document.querySelector("#reservations-list");
  if (!list) return;

  const stateFilter = document.querySelector("#reservation-filter-state")?.value || "";
  const materialFilter = document.querySelector("#reservation-filter-material")?.value || "";
  const dateFilter = document.querySelector("#reservation-filter-date")?.value || "";
  const search = normalizeText(document.querySelector("#reservation-search")?.value || "");

  const filtered = reservations
    .filter((reservation) => {
      if (stateFilter && reservation.estado !== stateFilter) return false;
      if (materialFilter && reservation.materialId !== materialFilter) return false;

      if (dateFilter) {
        const filterDay = dateFilter;
        const start = toInputDate(reservation.fechaInicio);
        const end = toInputDate(reservation.fechaFin);
        if (!(filterDay >= start && filterDay <= end)) return false;
      }

      if (search) {
        const haystack = normalizeText([
          reservation.userName,
          reservation.userEmail,
          reservation.userPhone,
          reservation.materialName,
          reservation.comentarioUsuario,
          reservation.notasAdmin,
          reservation.unidadCodigo
        ].join(" "));

        if (!haystack.includes(search)) return false;
      }

      return true;
    })
    .sort(compareReservations);

  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty-state">
        <strong>No hay solicitudes con esos filtros.</strong>
        Cambia filtros o actualiza la lista.
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map((reservation) => renderReservationCard(reservation)).join("");

  list.querySelectorAll("[data-action='approve']").forEach((button) => {
    button.addEventListener("click", () => {
      const reservation = reservations.find((item) => item.id === button.dataset.id);
      if (reservation) openApproveModal(reservation);
    });
  });

  list.querySelectorAll("[data-action='reject']").forEach((button) => {
    button.addEventListener("click", () => {
      const reservation = reservations.find((item) => item.id === button.dataset.id);
      if (reservation) rejectReservation(reservation);
    });
  });

  list.querySelectorAll("[data-action='status']").forEach((button) => {
    button.addEventListener("click", async () => {
      const reservation = reservations.find((item) => item.id === button.dataset.id);
      if (!reservation) return;

      await updateReservationStatus(reservation.id, button.dataset.state);
    });
  });

  list.querySelectorAll("[data-action='notes']").forEach((button) => {
    button.addEventListener("click", () => {
      const reservation = reservations.find((item) => item.id === button.dataset.id);
      if (reservation) openAdminNotesModal(reservation);
    });
  });
}

function renderReservationCard(reservation) {
  const estado = reservation.estado || "pendiente";
  const availableActions = getReservationActions(reservation);

  return `
    <article class="reservation-card card card-hover">
      <div class="reservation-head">
        <div>
          <h3>${escapeHtml(reservation.userName || "Usuario sin nombre")}</h3>
          <div class="meta">
            <span>${escapeHtml(reservation.materialName || "Material")}</span>
            <span>Creada: ${formatDate(reservation.creadaEn, true)}</span>
          </div>
        </div>
        <span class="badge badge-${escapeAttr(estado)}">${escapeHtml(capitalize(estado))}</span>
      </div>

      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">Contacto</span>
          <span class="detail-value">
            ${escapeHtml(reservation.userEmail || "-")}<br />
            ${escapeHtml(reservation.userPhone || "-")}
          </span>
        </div>

        <div class="detail-item">
          <span class="detail-label">Fechas</span>
          <span class="detail-value">${formatDate(reservation.fechaInicio)} → ${formatDate(reservation.fechaFin)}</span>
        </div>

        <div class="detail-item">
          <span class="detail-label">Unidad asignada</span>
          <span class="detail-value">${escapeHtml(reservation.unidadCodigo || "Sin asignar")}</span>
        </div>

        <div class="detail-item">
          <span class="detail-label">Normas</span>
          <span class="detail-value">${reservation.normasAceptadas ? "Aceptadas" : "No aceptadas"}</span>
        </div>
      </div>

      ${reservation.comentarioUsuario ? `
        <div class="detail-item">
          <span class="detail-label">Comentario usuario</span>
          <span class="detail-value">${escapeHtml(reservation.comentarioUsuario)}</span>
        </div>
      ` : ""}

      ${reservation.notasAdmin ? `
        <div class="detail-item">
          <span class="detail-label">Notas admin</span>
          <span class="detail-value">${escapeHtml(reservation.notasAdmin)}</span>
        </div>
      ` : ""}

      <div class="btn-row">
        ${availableActions}
        <button class="btn btn-secondary btn-small" data-action="notes" data-id="${escapeAttr(reservation.id)}" type="button">Notas admin</button>
      </div>
    </article>
  `;
}

function getReservationActions(reservation) {
  const id = escapeAttr(reservation.id);
  const estado = reservation.estado || "pendiente";
  const actions = [];

  if (estado === "pendiente") {
    actions.push(`<button class="btn btn-primary btn-small" data-action="approve" data-id="${id}" type="button">Aprobar</button>`);
    actions.push(`<button class="btn btn-danger btn-small" data-action="reject" data-id="${id}" type="button">Rechazar</button>`);
  }

  if (["pendiente", "aprobada"].includes(estado)) {
    actions.push(`<button class="btn btn-soft btn-small" data-action="status" data-state="cancelada" data-id="${id}" type="button">Cancelar</button>`);
  }

  if (estado === "aprobada") {
    actions.push(`<button class="btn btn-secondary btn-small" data-action="status" data-state="recogida" data-id="${id}" type="button">Recogida</button>`);
  }

  if (estado === "recogida") {
    actions.push(`<button class="btn btn-secondary btn-small" data-action="status" data-state="devuelta" data-id="${id}" type="button">Devuelta</button>`);
    actions.push(`<button class="btn btn-soft btn-small" data-action="status" data-state="incidencia" data-id="${id}" type="button">Incidencia</button>`);
  }

  if (["aprobada", "recogida", "pendiente"].includes(estado)) {
    actions.push(`<button class="btn btn-soft btn-small" data-action="status" data-state="vencida" data-id="${id}" type="button">Vencida</button>`);
  }

  return actions.join("");
}

async function updateReservationStatus(reservationId, nextStatus, extraPayload = {}) {
  try {
    const payload = {
      estado: nextStatus,
      actualizadaEn: serverTimestamp(),
      ...extraPayload
    };

    if (nextStatus === "recogida") {
      payload.recogidaEn = serverTimestamp();
    }

    if (nextStatus === "devuelta") {
      payload.devueltaEn = serverTimestamp();
    }

    await updateDoc(doc(db, "reservas", reservationId), payload);
    showToast(`Reserva marcada como ${nextStatus}.`, "success");
    await loadReservations();
  } catch (error) {
    console.error(error);
    showToast("Error al actualizar la reserva.", "error");
  }
}

function openApproveModal(reservation) {
  const availableUnits = units.filter((unit) =>
    unit.materialId === reservation.materialId &&
    unit.activo !== false &&
    unit.estado === "disponible"
  );

  const modal = createModal(`
    <form id="approve-form" class="form-stack">
      <div class="info-box">
        Puedes aprobar sin asignar unidad todavía. Si seleccionas una unidad, se guardará en la reserva, pero no se cambiará automáticamente el estado de la unidad.
      </div>

      <div class="field">
        <label for="approve-unit">Unidad disponible, opcional</label>
        <select id="approve-unit" class="select">
          <option value="">Sin asignar unidad</option>
          ${availableUnits.map((unit) => `
            <option value="${escapeAttr(unit.id)}">${escapeHtml(unit.codigoInterno || unit.id)}</option>
          `).join("")}
        </select>
        ${availableUnits.length ? "" : `<span class="help">No hay unidades disponibles para este material.</span>`}
      </div>

      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Aprobar reserva</button>
        <button class="btn btn-secondary" data-close-modal type="button">Cancelar</button>
      </div>
    </form>
  `, `Aprobar reserva · ${reservation.materialName || "Material"}`);

  modal.querySelector("#approve-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const unitId = modal.querySelector("#approve-unit").value || null;
    await approveReservation(reservation, unitId);
    closeModal(modal);
  });
}

async function approveReservation(reservation, unitId = null) {
  try {
    const payload = {
      estado: "aprobada",
      aprobadaPorUid: currentUser.uid,
      aprobadaPorNombre: currentAdminProfile?.nombre || currentUser.email || "Admin",
      aprobadaEn: serverTimestamp(),
      actualizadaEn: serverTimestamp()
    };

    if (unitId) {
      const selectedUnit = units.find((unit) => unit.id === unitId);
      if (selectedUnit) {
        payload.unidadId = selectedUnit.id;
        payload.unidadCodigo = selectedUnit.codigoInterno || selectedUnit.id;
      }
    }

    await updateDoc(doc(db, "reservas", reservation.id), payload);
    showToast("Reserva aprobada.", "success");
    await loadReservations();
  } catch (error) {
    console.error(error);
    showToast("Error al aprobar la reserva.", "error");
  }
}

async function rejectReservation(reservation) {
  const motivo = window.prompt("Motivo de rechazo:");
  if (motivo === null) return;

  const cleanReason = motivo.trim();
  if (!cleanReason) {
    showToast("Indica un motivo de rechazo.", "error");
    return;
  }

  try {
    await updateDoc(doc(db, "reservas", reservation.id), {
      estado: "rechazada",
      rechazadaPorUid: currentUser.uid,
      rechazadaPorNombre: currentAdminProfile?.nombre || currentUser.email || "Admin",
      rechazadaEn: serverTimestamp(),
      motivoRechazo: cleanReason,
      actualizadaEn: serverTimestamp()
    });

    showToast("Reserva rechazada.", "success");
    await loadReservations();
  } catch (error) {
    console.error(error);
    showToast("Error al rechazar la reserva.", "error");
  }
}

async function assignUnitToReservation(reservationId, unitId) {
  const unit = units.find((item) => item.id === unitId);
  if (!unit) {
    showToast("Unidad no encontrada.", "error");
    return;
  }

  try {
    await updateDoc(doc(db, "reservas", reservationId), {
      unidadId: unit.id,
      unidadCodigo: unit.codigoInterno || unit.id,
      actualizadaEn: serverTimestamp()
    });

    showToast("Unidad asignada a la reserva.", "success");
    await loadReservations();
  } catch (error) {
    console.error(error);
    showToast("Error al asignar unidad.", "error");
  }
}

function openAdminNotesModal(reservation) {
  const modal = createModal(`
    <form id="admin-notes-form" class="form-stack">
      <div class="field">
        <label for="admin-notes">Notas admin</label>
        <textarea id="admin-notes" class="textarea">${escapeHtml(reservation.notasAdmin || "")}</textarea>
      </div>

      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Guardar notas</button>
        <button class="btn btn-secondary" data-close-modal type="button">Cancelar</button>
      </div>
    </form>
  `, `Notas admin · ${reservation.userName || "Reserva"}`);

  modal.querySelector("#admin-notes-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveAdminNotes(reservation.id, modal.querySelector("#admin-notes").value.trim());
    closeModal(modal);
  });
}

async function saveAdminNotes(reservationId, notes) {
  try {
    await updateDoc(doc(db, "reservas", reservationId), {
      notasAdmin: notes,
      actualizadaEn: serverTimestamp()
    });

    showToast("Notas guardadas.", "success");
    await loadReservations();
  } catch (error) {
    console.error(error);
    showToast("Error al guardar notas.", "error");
  }
}

function compareReservations(a, b) {
  const priorityA = statePriority[a.estado || "pendiente"] ?? 99;
  const priorityB = statePriority[b.estado || "pendiente"] ?? 99;

  if (priorityA !== priorityB) return priorityA - priorityB;

  const startA = timestampToMillis(a.fechaInicio) || Number.MAX_SAFE_INTEGER;
  const startB = timestampToMillis(b.fechaInicio) || Number.MAX_SAFE_INTEGER;

  if (startA !== startB) return startA - startB;

  return (timestampToMillis(b.creadaEn) || 0) - (timestampToMillis(a.creadaEn) || 0);
}

function formatDate(value, includeTime = false) {
  if (!value) return "-";

  const date = timestampToDate(value);
  if (!date) return "-";

  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {})
  }).format(date);
}

function toInputDate(value) {
  const date = timestampToDate(value);
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timestampToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  return null;
}

function timestampToMillis(value) {
  const date = timestampToDate(value);
  return date ? date.getTime() : 0;
}

function setLoading(message = "Cargando…") {
  els.app.innerHTML = `
    <section class="screen-center">
      <div class="loader-card">
        <div class="spinner" aria-hidden="true"></div>
        <p>${escapeHtml(message)}</p>
      </div>
    </section>
  `;
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  els.toastRoot.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 4200);
}

function showInlineError(element, message) {
  element.textContent = message;
  element.classList.remove("hidden");
}

function createModal(bodyHtml, title) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <article class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header">
        <h2 id="modal-title" class="modal-title">${escapeHtml(title)}</h2>
        <button class="close-btn" data-close-modal type="button" aria-label="Cerrar">×</button>
      </header>
      <div class="modal-body">
        ${bodyHtml}
      </div>
    </article>
  `;

  document.body.appendChild(backdrop);

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop || event.target.closest("[data-close-modal]")) {
      closeModal(backdrop);
    }
  });

  document.addEventListener("keydown", closeOnEscape);
  return backdrop;
}

function closeModal(modal) {
  modal.remove();
  document.removeEventListener("keydown", closeOnEscape);
}

function closeOnEscape(event) {
  if (event.key !== "Escape") return;
  const modal = document.querySelector(".modal-backdrop");
  if (modal) closeModal(modal);
}

function getAuthErrorMessage(error) {
  const code = error?.code || "";

  if (code.includes("invalid-credential")) return "Email o contraseña incorrectos.";
  if (code.includes("user-not-found")) return "No existe una cuenta con ese email.";
  if (code.includes("wrong-password")) return "Contraseña incorrecta.";
  if (code.includes("too-many-requests")) return "Demasiados intentos. Espera unos minutos.";
  if (code.includes("network-request-failed")) return "Error de red. Revisa la conexión.";

  return "No se ha podido iniciar sesión.";
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function capitalize(value) {
  const text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatMoney(value) {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

