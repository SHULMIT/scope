// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { ProjectFirstRunView } from "./ProjectGate";
import { Button } from "@/components/ui/button";
import type { Project } from "@/types";

const PROJECTS: Project[] = [
  { _id: "p-alpha", id: "p-alpha", name: "Alpha", description: "Primary benchmark project" },
  { _id: "p-bravo", id: "p-bravo", name: "Bravo" },
] as Project[];

// A stand-in for the real <ProjectCreateForm> (which owns a mutation); the view
// only renders it as an opaque slot, so a stub keeps the story pure.
const CreateSlot = <Button type="button">Create &amp; open</Button>;

const meta = {
  component: ProjectFirstRunView,
  args: {
    projects: PROJECTS,
    onSelect: () => {},
    createSlot: CreateSlot,
  },
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof ProjectFirstRunView>;

export default meta;
type Story = StoryObj<typeof meta>;

function FirstRunHarness({ projects, isLoading }: { projects: Project[]; isLoading?: boolean }) {
  const [selected, setSelected] = useState<string | undefined>();
  return (
    <div>
      <ProjectFirstRunView
        projects={projects}
        isLoading={isLoading}
        onSelect={setSelected}
        createSlot={CreateSlot}
      />
      <span data-testid="selected">{selected ?? ""}</span>
    </div>
  );
}

export const WithProjects: Story = {
  render: () => <FirstRunHarness projects={PROJECTS} />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: /select a project/i })).toBeVisible();
    // Picking an existing project reports it upward.
    await userEvent.click(canvas.getByRole("button", { name: /alpha/i }));
    await expect(canvas.getByTestId("selected")).toHaveTextContent("p-alpha");
  },
};

export const FirstRunEmpty: Story = {
  render: () => <FirstRunHarness projects={[]} />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: /select a project/i })).toBeVisible();
    // No project list card, but the create-your-first affordance is shown.
    await expect(canvas.getByText(/create your first project/i)).toBeVisible();
  },
};

export const Loading: Story = {
  render: () => <FirstRunHarness projects={[]} isLoading />,
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/loading projects/i)).toBeVisible();
  },
};
