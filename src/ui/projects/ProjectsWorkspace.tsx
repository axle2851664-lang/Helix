import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import { toUserMessage } from '../../core/HelixError.js';
import { ACCEPT_ATTRIBUTE, formatBytes } from '../../projects/validation.js';
import type { ProjectAsset, ProjectSummary } from '../../projects/types.js';

/**
 * Project import and management (spec 7, 12, 19).
 *
 * Everything here is real: files are validated, stored and read back. A project
 * name is required before anything can be imported, and originals are listed
 * separately from generated output so the distinction is visible rather than
 * merely recorded.
 */
export function ProjectsWorkspace({
  selectedProjectId,
  onSelectProject,
}: {
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
}) {
  const { projects } = useHelix();
  const [list, setList] = useState<ProjectSummary[]>([]);

  const refresh = useCallback(() => {
    void projects.listProjects().then(setList);
  }, [projects]);

  useEffect(() => {
    refresh();
    return projects.subscribe(refresh);
  }, [refresh, projects]);

  const selected = list.find((project) => project.id === selectedProjectId) ?? null;

  if (selected) {
    return <ProjectDetail project={selected} onBack={() => onSelectProject(null)} />;
  }

  return (
    <div className="hx-page">
      <ImportPanel onImported={(projectId) => onSelectProject(projectId)} />

      {list.length === 0 ? (
        <div className="hx-panel hx-empty">
          <Icon name="folder" size={26} />
          <p>No projects yet.</p>
          <p className="hx-muted">Import a file above to create your first one.</p>
        </div>
      ) : (
        <div className="hx-panel">
          <h2 className="hx-panel__title">
            {list.length} {list.length === 1 ? 'project' : 'projects'}
          </h2>
          <ul className="hx-projlist">
            {list.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className="hx-projlist__row"
                  onClick={() => onSelectProject(project.id)}
                >
                  <span className="hx-projlist__name">{project.name}</span>
                  <span className="hx-projlist__meta">
                    {project.assetCount} {project.assetCount === 1 ? 'file' : 'files'}
                    {project.generatedCount > 0 && ` (${project.generatedCount} generated)`}
                    {project.totalBytes > 0 && ` · ${formatBytes(project.totalBytes)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="hx-settings__note">
            Ask Helix to &ldquo;open my {list[0]?.name} project&rdquo; from the home screen.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Import. A project name is mandatory - the file picker stays disabled until
 * one is given, so a file can never land in an unnamed bucket.
 */
function ImportPanel({ onImported }: { onImported: (projectId: string) => void }) {
  const { projects, activity, logger } = useHelix();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const nameGiven = name.trim() !== '';

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);

    const token = activity.begin('opening-project', {
      label: 'Importing...',
      detail: name.trim(),
    });

    try {
      const project = await projects.createProject(name.trim(), description.trim());
      const failures: string[] = [];

      for (const file of Array.from(files)) {
        try {
          await projects.addFileToProject({
            projectId: project.id,
            file: { name: file.name, size: file.size, type: file.type },
            data: await file.arrayBuffer(),
          });
        } catch (fileError) {
          // One bad file must not abandon the rest of the import.
          failures.push(toUserMessage(fileError));
          logger.warn('Rejected a file during import.', fileError);
        }
      }

      if (failures.length > 0) setError(failures.join(' '));

      const imported = await projects.getSummary(project.id);
      if (imported && imported.assetCount === 0) {
        // Nothing was accepted, so do not leave an empty project behind.
        await projects.deleteProject(project.id);
        token.end('failed');
        return;
      }

      token.end('completed');
      setName('');
      setDescription('');
      onImported(project.id);
    } catch (importError) {
      setError(toUserMessage(importError));
      token.end('failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <section className="hx-panel">
      <h2 className="hx-panel__title">Import into a new project</h2>

      <div className="hx-field">
        <label className="hx-field__label" htmlFor="project-name">
          Project name <span className="hx-field__required">required</span>
        </label>
        <input
          id="project-name"
          className="hx-input"
          value={name}
          maxLength={120}
          placeholder="Iron Man"
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="hx-field">
        <label className="hx-field__label" htmlFor="project-description">
          Description
        </label>
        <input
          id="project-description"
          className="hx-input"
          value={description}
          maxLength={300}
          placeholder="Optional"
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="hx-hidden-input"
        onChange={(event) => void handleFiles(event.target.files)}
      />

      <div className="hx-field__actions">
        <button
          type="button"
          className="hx-btn"
          disabled={!nameGiven || busy}
          onClick={() => inputRef.current?.click()}
        >
          <Icon name="upload" size={15} /> Choose files
        </button>
        {!nameGiven && <span className="hx-muted">Name the project first.</span>}
        {busy && <span className="hx-muted">Importing...</span>}
      </div>

      {error && (
        <div className="hx-notice hx-notice--warn hx-field__error" role="alert">
          {error}
        </div>
      )}

      <p className="hx-settings__note">
        Images, 3D models, documents and data files are accepted. Programs and scripts are refused,
        and nothing imported is ever executed.
      </p>
    </section>
  );
}

function ProjectDetail({ project, onBack }: { project: ProjectSummary; onBack: () => void }) {
  const { projects } = useHelix();
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const refresh = useCallback(() => {
    void projects.listAssets(project.id).then(setAssets);
  }, [projects, project.id]);

  useEffect(() => {
    refresh();
    return projects.subscribe(refresh);
  }, [refresh, projects]);

  const originals = assets.filter((asset) => asset.origin === 'original');
  const generated = assets.filter((asset) => asset.origin === 'generated');

  return (
    <div className="hx-page">
      <div className="hx-detailhead">
        <button type="button" className="hx-btn hx-btn--quiet" onClick={onBack}>
          Back to projects
        </button>
        <span className="hx-muted">{projects.projectPath(project.id)}</span>
      </div>

      <section className="hx-panel">
        <h2 className="hx-panel__title">{project.name}</h2>
        {project.description && <p className="hx-muted">{project.description}</p>}
        <div className="hx-row">
          <span className="hx-row__label">Created</span>
          <span className="hx-row__value">{new Date(project.createdAt).toLocaleString()}</span>
        </div>
        <div className="hx-row">
          <span className="hx-row__label">Files</span>
          <span className="hx-row__value">
            {project.assetCount} ({originals.length} original, {generated.length} generated)
          </span>
        </div>
        <div className="hx-row">
          <span className="hx-row__label">Size</span>
          <span className="hx-row__value">{formatBytes(project.totalBytes)}</span>
        </div>
      </section>

      <AssetList title="Original files" assets={originals} emptyText="No originals." />
      <AssetList
        title="Generated files"
        assets={generated}
        emptyText="Nothing has been generated from this project yet. Image-to-3D arrives in a later phase."
      />

      <section className="hx-panel">
        <h2 className="hx-panel__title">Danger zone</h2>
        {confirmingDelete ? (
          <div className="hx-notice hx-notice--warn">
            <strong>Delete &ldquo;{project.name}&rdquo; and all {project.assetCount} of its files?</strong>{' '}
            This cannot be undone.
            <div className="hx-field__actions">
              <button
                type="button"
                className="hx-btn hx-btn--danger"
                onClick={() => {
                  void projects.deleteProject(project.id).then(onBack);
                }}
              >
                Delete permanently
              </button>
              <button
                type="button"
                className="hx-btn hx-btn--quiet"
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="hx-btn" onClick={() => setConfirmingDelete(true)}>
            Delete this project
          </button>
        )}
      </section>
    </div>
  );
}

function AssetList({
  title,
  assets,
  emptyText,
}: {
  title: string;
  assets: ProjectAsset[];
  emptyText: string;
}) {
  const { projects } = useHelix();

  return (
    <section className="hx-panel">
      <h2 className="hx-panel__title">{title}</h2>
      {assets.length === 0 ? (
        <p className="hx-muted">{emptyText}</p>
      ) : (
        <ul className="hx-assetlist">
          {assets.map((asset) => (
            <li className="hx-assetlist__row" key={asset.id}>
              <AssetThumb asset={asset} />
              <div className="hx-assetlist__body">
                <div className="hx-assetlist__name">{asset.fileName}</div>
                <div className="hx-assetlist__meta">
                  {asset.kind} &middot; {formatBytes(asset.sizeBytes)} &middot;{' '}
                  {new Date(asset.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                type="button"
                className="hx-iconbtn"
                aria-label={`Remove ${asset.fileName}`}
                onClick={() => void projects.removeFileFromProject(asset.id)}
              >
                <Icon name="close" size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Renders a stored image from its bytes; other kinds get an icon. */
function AssetThumb({ asset }: { asset: ProjectAsset }) {
  const { projects } = useHelix();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (asset.kind !== 'image') return;
    let objectUrl: string | null = null;
    let cancelled = false;

    void projects.getAssetData(asset.id).then((data) => {
      if (cancelled || !data) return;
      const blob = data instanceof Blob ? data : new Blob([data], { type: asset.mimeType });
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });

    return () => {
      cancelled = true;
      // Object URLs leak until revoked; the browser will not do it for us.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.id, asset.kind, asset.mimeType, projects]);

  if (asset.kind === 'image' && url) {
    return <img className="hx-assetthumb" src={url} alt={asset.fileName} />;
  }

  return (
    <span className="hx-assetthumb hx-assetthumb--icon">
      <Icon name={asset.kind === 'model3d' ? 'earth' : 'folder'} size={17} />
    </span>
  );
}
