import { useEffect, useRef, useState, type FormEvent } from 'react';
import { exportPlotAsStl } from '../../persistence/meshExport';
import { readProjectFile, saveProjectFile } from '../../persistence/projectFile';
import { useAppStore } from '../../state/store';
import type { ViewportApi } from '../../renderer/SceneController';
import type { PlotObject } from '../../types/contracts';

const APP_GITHUB_URL = 'https://github.com/davbachman/STEVE';
const DAVID_BACHMAN_URL = 'https://davidbachmandesign.com';
const ENTROPY_BONUS_URL = 'https://profbachman.substack.com';
const FEEDBACK_EMAIL = 'bachman@pitzer.edu';
const FEEDBACK_CATEGORIES = ['Feature Request', 'Bug Report', 'Contact'] as const;

type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number];

interface TopBarProps {
  viewportApi: ViewportApi | null;
  leftSidebarVisible: boolean;
  rightSidebarVisible: boolean;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
}

export function TopBar({
  viewportApi,
  leftSidebarVisible,
  rightSidebarVisible,
  onToggleLeftSidebar,
  onToggleRightSidebar,
}: TopBarProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const menuBarRef = useRef<HTMLDivElement | null>(null);
  const [exportScale, setExportScale] = useState(1);
  const [activeMenu, setActiveMenu] = useState<'steve' | 'file' | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackCategories, setFeedbackCategories] = useState<FeedbackCategory[]>([]);
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const exportProjectFile = useAppStore((s) => s.exportProjectFile);
  const replaceProject = useAppStore((s) => s.replaceProject);
  const newProject = useAppStore((s) => s.newProject);
  const objects = useAppStore((s) => s.objects);
  const render = useAppStore((s) => s.render);
  const selectedId = useAppStore((s) => s.selectedId);
  const updateRender = useAppStore((s) => s.updateRender);
  const selectedPlot = selectedId
    ? objects.find((obj): obj is PlotObject => obj.id === selectedId && obj.type === 'plot') ?? null
    : null;

  useEffect(() => {
    if (!activeMenu) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuBarRef.current?.contains(event.target as Node)) {
        setActiveMenu(null);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [activeMenu]);

  useEffect(() => {
    if (!activeMenu && !aboutOpen && !feedbackOpen && !settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setActiveMenu(null);
      setAboutOpen(false);
      setFeedbackOpen(false);
      setSettingsOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [aboutOpen, activeMenu, feedbackOpen, settingsOpen]);

  const handleSaveProject = () => {
    void (async () => {
      try {
        await saveProjectFile(exportProjectFile());
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error(error instanceof Error ? error.message : 'Failed to save project');
      }
    })();
  };

  const handleExportPng = () => {
    void (async () => {
      if (!viewportApi) {
        return;
      }
      try {
        await viewportApi.exportPng(undefined, exportScale);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error(error instanceof Error ? error.message : 'Failed to export PNG');
      }
    })();
  };

  const handleExportStl = () => {
    if (!selectedPlot) {
      return;
    }
    void (async () => {
      try {
        await exportPlotAsStl(selectedPlot);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error(error instanceof Error ? error.message : 'Failed to export STL');
      }
    })();
  };

  const openAbout = () => {
    setActiveMenu(null);
    setAboutOpen(true);
  };

  const openFeedback = () => {
    setActiveMenu(null);
    setFeedbackCategories([]);
    setFeedbackMessage('');
    setFeedbackOpen(true);
  };

  const openSettings = () => {
    setActiveMenu(null);
    setSettingsOpen(true);
  };

  const toggleFeedbackCategory = (category: FeedbackCategory) => {
    setFeedbackCategories((categories) => (
      categories.includes(category)
        ? categories.filter((candidate) => candidate !== category)
        : [...categories, category]
    ));
  };

  const handleFeedbackSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = feedbackMessage.trim();
    if (feedbackCategories.length === 0 || !message) return;

    const subject = `STEVE: ${feedbackCategories.join(', ')}`;
    const mailtoUrl = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
    window.open(mailtoUrl, '_self');
    setFeedbackOpen(false);
  };

  const closeMenusThen = (action: () => void) => {
    setActiveMenu(null);
    action();
  };

  return (
    <>
      <header className="top-bar">
        <div ref={menuBarRef} className="top-bar__menu-bar" aria-label="Application menus">
          <div className="top-bar__menu">
            <button
              type="button"
              className={activeMenu === 'steve' ? 'top-bar__menu-trigger is-active' : 'top-bar__menu-trigger'}
              aria-haspopup="menu"
              aria-expanded={activeMenu === 'steve'}
              onClick={() => setActiveMenu((menu) => menu === 'steve' ? null : 'steve')}
            >
              <strong>STEVE</strong>
              <span className="top-bar__menu-caret" aria-hidden="true">▾</span>
            </button>
            {activeMenu === 'steve' ? (
              <div className="top-bar__menu-popover" role="menu" aria-label="STEVE menu">
                <button type="button" role="menuitem" onClick={openAbout}>About</button>
                <a
                  role="menuitem"
                  href={APP_GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setActiveMenu(null)}
                >
                  Instructions
                </a>
                <button type="button" role="menuitem" onClick={openFeedback}>Feedback</button>
                <button type="button" role="menuitem" onClick={openSettings}>Settings</button>
              </div>
            ) : null}
          </div>

          <div className="top-bar__menu">
            <button
              type="button"
              className={activeMenu === 'file' ? 'top-bar__menu-trigger is-active' : 'top-bar__menu-trigger'}
              aria-haspopup="menu"
              aria-expanded={activeMenu === 'file'}
              onClick={() => setActiveMenu((menu) => menu === 'file' ? null : 'file')}
            >
              File
              <span className="top-bar__menu-caret" aria-hidden="true">▾</span>
            </button>
            {activeMenu === 'file' ? (
              <div className="top-bar__menu-popover" role="menu" aria-label="File menu">
                <button type="button" role="menuitem" onClick={() => closeMenusThen(newProject)}>New</button>
                <button type="button" role="menuitem" onClick={() => closeMenusThen(handleSaveProject)}>Save</button>
                <button type="button" role="menuitem" onClick={() => closeMenusThen(() => fileInputRef.current?.click())}>Open</button>
                <button type="button" role="menuitem" disabled={!viewportApi} onClick={() => closeMenusThen(handleExportPng)}>Export PNG</button>
                <button type="button" role="menuitem" disabled={!selectedPlot} onClick={() => closeMenusThen(handleExportStl)}>Export STL</button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="top-bar__group top-bar__group--right">
          <div className="top-bar__sidebar-toggles" aria-label="Sidebar visibility">
            <button
              className={leftSidebarVisible ? 'top-bar__toggle top-bar__toggle--icon is-active' : 'top-bar__toggle top-bar__toggle--icon'}
              onClick={onToggleLeftSidebar}
              title={leftSidebarVisible ? 'Hide left panel' : 'Show left panel'}
              aria-label={leftSidebarVisible ? 'Hide left panel' : 'Show left panel'}
              aria-pressed={leftSidebarVisible}
            >
              <PanelToggleIcon side="left" />
            </button>
            <button
              className={rightSidebarVisible ? 'top-bar__toggle top-bar__toggle--icon is-active' : 'top-bar__toggle top-bar__toggle--icon'}
              onClick={onToggleRightSidebar}
              title={rightSidebarVisible ? 'Hide right panel' : 'Show right panel'}
              aria-label={rightSidebarVisible ? 'Hide right panel' : 'Show right panel'}
              aria-pressed={rightSidebarVisible}
            >
              <PanelToggleIcon side="right" />
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.3dplot.json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void (async () => {
              try {
                const project = await readProjectFile(file);
                replaceProject(project);
              } catch (err) {
                console.error(err instanceof Error ? err.message : 'Failed to open project');
              } finally {
                e.target.value = '';
              }
            })();
          }}
        />
      </header>

      {aboutOpen ? (
        <div
          className="settings-overlay"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setAboutOpen(false);
          }}
        >
          <section className="settings-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
            <header className="settings-dialog__header">
              <h2 id="about-title">ST.E.V.E.</h2>
              <button
                type="button"
                className="settings-dialog__close"
                aria-label="Close about"
                title="Close about"
                autoFocus
                onClick={() => setAboutOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="about-dialog__body">
              <p className="about-dialog__subtitle">STudio for Equation Visualization and Experimentation</p>
              <p>
                by <a href={DAVID_BACHMAN_URL} target="_blank" rel="noopener noreferrer">David Bachman</a>{' '}
                with GPT 5.4, 5.5, 5.6 Sol, and Fable 5.
              </p>
              <p>
                For more apps and AI info, subscribe to{' '}
                <a href={ENTROPY_BONUS_URL} target="_blank" rel="noopener noreferrer">Entropy Bonus</a>.
              </p>
            </div>
          </section>
        </div>
      ) : null}

      {feedbackOpen ? (
        <div
          className="settings-overlay"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setFeedbackOpen(false);
          }}
        >
          <section className="settings-dialog feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
            <header className="settings-dialog__header">
              <h2 id="feedback-title">Feedback</h2>
              <button
                type="button"
                className="settings-dialog__close"
                aria-label="Close feedback"
                title="Close feedback"
                onClick={() => setFeedbackOpen(false)}
              >
                ×
              </button>
            </header>
            <form className="feedback-dialog__form" onSubmit={handleFeedbackSubmit}>
              <fieldset>
                <legend>What would you like to send?</legend>
                <div className="feedback-dialog__categories">
                  {FEEDBACK_CATEGORIES.map((category, index) => (
                    <label key={category}>
                      <input
                        type="checkbox"
                        checked={feedbackCategories.includes(category)}
                        autoFocus={index === 0}
                        onChange={() => toggleFeedbackCategory(category)}
                      />
                      <span>{category}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="feedback-dialog__message">
                <span>Message</span>
                <textarea
                  value={feedbackMessage}
                  onChange={(event) => setFeedbackMessage(event.target.value)}
                  placeholder="Tell us what you would like to see, what went wrong, or how we can help."
                  rows={6}
                />
              </label>
              <p className="feedback-dialog__hint">Send will open a draft in your default email client.</p>
              <div className="feedback-dialog__actions">
                <button type="button" onClick={() => setFeedbackOpen(false)}>Cancel</button>
                <button
                  type="submit"
                  disabled={feedbackCategories.length === 0 || feedbackMessage.trim().length === 0}
                >
                  Send
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {settingsOpen ? (
        <div
          className="settings-overlay"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header className="settings-dialog__header">
              <h2 id="settings-title">Settings</h2>
              <button
                type="button"
                className="settings-dialog__close"
                aria-label="Close settings"
                title="Close settings"
                autoFocus
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="settings-dialog__body">
              <label>
                <span>PNG Export Quality</span>
                <select
                  value={exportScale}
                  onChange={(e) => setExportScale(Number(e.target.value))}
                  aria-label="PNG Export Quality"
                >
                  <option value={1}>Standard (1×)</option>
                  <option value={2}>High (2×)</option>
                  <option value={4}>Ultra (4×)</option>
                </select>
              </label>
              <label>
                <span>Interactive Quality</span>
                <select
                  value={render.interactiveQuality}
                  onChange={(e) => updateRender({ interactiveQuality: e.target.value as typeof render.interactiveQuality })}
                  aria-label="Interactive Quality"
                >
                  <option value="performance">Performance</option>
                  <option value="balanced">Balanced</option>
                  <option value="quality">Quality</option>
                </select>
              </label>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function PanelToggleIcon({ side }: { side: 'left' | 'right' }) {
  const panelX = side === 'left' ? 2 : 13.5;
  return (
    <svg viewBox="0 0 20 14" width="16" height="14" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x={panelX} y="2" width="4.5" height="10" rx="1" fill="currentColor" opacity="0.5" />
    </svg>
  );
}
