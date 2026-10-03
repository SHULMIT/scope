// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, CircleCheck, FolderKanban, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ProjectCreateForm } from "@/components/ProjectCreateForm";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DataTable, ListLayout, type DataTableColumn } from "@/components/list-layout";
import { useProjectContext } from "@/contexts/ProjectContext";
import { useSelectProject } from "@/hooks/useSelectProject";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import type { Project } from "@/types";

/** Stable id accessor — the API mirrors `_id` onto `id`, but fall back defensively. */
function projectId(project: Project): string {
  return project.id ?? project._id;
}

const NAME_MAX = 128;
const DESCRIPTION_MAX = 512;

/** Inline rename / re-describe dialog. */
function EditProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");

  const updateMutation = useMutation({
    mutationFn: () =>
      api.updateProject(projectId(project), {
        name: name.trim(),
        description: description.trim(),
      }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`Project "${updated.name}" updated`);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to update project");
    },
  });

  const nameTooLong = name.length > NAME_MAX;
  const descriptionTooLong = description.length > DESCRIPTION_MAX;
  const canSubmit = !!name.trim() && !nameTooLong && !descriptionTooLong;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
          <DialogDescription>Rename or re-describe this project.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit && !updateMutation.isPending) updateMutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="edit-project-name">Name *</Label>
            <Input
              id="edit-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={nameTooLong ? "border-destructive" : undefined}
            />
            {nameTooLong && (
              <p className="text-xs text-destructive">
                Name must be {NAME_MAX} characters or fewer
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-project-description">Description</Label>
            <Textarea
              id="edit-project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={descriptionTooLong ? "border-destructive" : undefined}
            />
            {descriptionTooLong && (
              <p className="text-xs text-destructive">
                Description must be {DESCRIPTION_MAX} characters or fewer
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || updateMutation.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Projects management page — list, create, rename/describe, and soft-delete
 * projects. Projects are the top-level **unscoped** container, so this page is
 * not wrapped in `ProjectGate` and works with no project selected.
 */
export function Projects() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { selectedProjectId } = useProjectContext();
  const selectProject = useSelectProject();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  /**
   * Select a project and open its dashboard. Selecting scopes the whole portal
   * to that project (see `useSelectProject`); we then redirect to `/statistics`
   * so the user lands on the project's overview. Wired to both the row click and
   * the "Use project" button so the two entry points behave identically.
   */
  const openProject = (project: Project) => {
    // Deleted projects are not selectable — they must be restored first.
    if (project.deletedAt) return;
    const id = projectId(project);
    if (id !== selectedProjectId) selectProject(id);
    navigate("/statistics");
  };

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects", { includeDeleted: showDeleted }],
    queryFn: () => api.listProjects({ includeDeleted: showDeleted }),
  });

  // The server already excludes soft-deleted projects unless includeDeleted is
  // set, but filter defensively so toggling off never flashes a stale deleted row.
  const visibleProjects = useMemo(
    () => (showDeleted ? projects : projects.filter((p) => !p.deletedAt)),
    [projects, showDeleted],
  );

  const deleteMutation = useMutation({
    mutationFn: (project: Project) => api.deleteProject(projectId(project)),
    onSuccess: (_data, project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`Project "${project.name}" deleted`);
      // If the deleted project was the active selection, clear it so scoped
      // pages fall back to the first-run gate instead of a dangling scope.
      if (projectId(project) === selectedProjectId) selectProject(undefined);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to delete project");
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (project: Project) => api.restoreProject(projectId(project)),
    onSuccess: (_data, project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`Project "${project.name}" restored`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to restore project");
    },
  });

  const columns: DataTableColumn<Project>[] = [
    {
      id: "name",
      header: "Name",
      cell: (p) => {
        const isActive = projectId(p) === selectedProjectId;
        const isDeleted = !!p.deletedAt;
        return (
          <div className="flex items-center gap-2">
            <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={`font-medium ${isDeleted ? "text-muted-foreground line-through" : ""}`}>
              {p.name}
            </span>
            {isDeleted ? (
              <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
                <Trash2 className="h-3 w-3" />
                Deleted
              </Badge>
            ) : (
              isActive && (
                <Badge className="gap-1 text-xs">
                  <Check className="h-3 w-3" />
                  Active
                </Badge>
              )
            )}
          </div>
        );
      },
    },
    {
      id: "description",
      header: "Description",
      cell: (p) => (
        <span className="block max-w-[320px] truncate text-sm text-muted-foreground" title={p.description}>
          {p.description || "—"}
        </span>
      ),
    },
    {
      id: "created",
      header: "Created",
      width: "150px",
      cell: (p) => <span className="text-xs text-muted-foreground">{formatDate(p.createdAt)}</span>,
    },
    {
      id: "actions",
      header: "",
      width: "220px",
      align: "right",
      cell: (p) => {
        const isActive = projectId(p) === selectedProjectId;
        if (p.deletedAt) {
          return (
            <div
              className="flex items-center justify-end gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                aria-label={`Restore ${p.name}`}
                disabled={restoreMutation.isPending}
                onClick={() => restoreMutation.mutate(p)}
              >
                <RotateCcw className="h-4 w-4" />
                Restore
              </Button>
            </div>
          );
        }
        return (
          <div
            className="flex items-center justify-end gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            {isActive ? (
              <span className="mr-1 inline-flex items-center gap-1 text-xs font-medium text-primary">
                <CircleCheck className="h-4 w-4" />
                In use
              </span>
            ) : (
              <Button
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => openProject(p)}
              >
                Use project
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={`Edit ${p.name}`}
              onClick={() => setEditing(p)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  aria-label={`Delete ${p.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete project “{p.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This soft-deletes the project and hides it (along with any runs and
                    resources it contains) from the default lists. You can bring it back
                    anytime with the <span className="font-medium">Show deleted</span> toggle.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => deleteMutation.mutate(p)}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        );
      },
    },
  ];

  return (
    <>
      <ListLayout
        title="Projects"
        description="Organize runs, profiles, criteria, and more into isolated projects."
        filterRail={null}
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New project
          </Button>
        }
      >
        <div className="p-4">
          <div className="mb-4 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <FolderKanban className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Select a project to scope the whole portal &mdash; runs, profiles, criteria, MCP
              servers, and more &mdash; to it. Selecting opens the project&rsquo;s{" "}
              <span className="font-medium text-foreground">Statistics</span>, and your active
              project stays switchable from the top bar.
            </p>
          </div>
          <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
            <Label htmlFor="show-deleted-projects" className="text-sm text-muted-foreground">
              Show deleted
            </Label>
            <Switch
              id="show-deleted-projects"
              checked={showDeleted}
              onCheckedChange={setShowDeleted}
              aria-label="Show deleted projects"
            />
          </div>
          <DataTable
            items={visibleProjects}
            columns={columns}
            getRowId={(p) => projectId(p)}
            activeId={selectedProjectId ?? null}
            onRowClick={openProject}
            loading={isLoading}
            emptyState={
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <FolderKanban className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No projects yet. Create one to get started.
                </p>
                <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" />
                  New project
                </Button>
              </div>
            }
          />
        </div>
      </ListLayout>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Create a project to organize runs, profiles, criteria, and more.
            </DialogDescription>
          </DialogHeader>
          <ProjectCreateForm
            onCancel={() => setCreateOpen(false)}
            onCreated={() => {
              setCreateOpen(false);
              queryClient.invalidateQueries({ queryKey: ["projects"] });
            }}
          />
        </DialogContent>
      </Dialog>

      {editing && (
        <EditProjectDialog
          project={editing}
          open={!!editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}
    </>
  );
}
