import { ProjectProvider } from "./state";
import Workbench from "./pages/Workbench";

export default function App() {
  return (
    <ProjectProvider>
      <Workbench />
    </ProjectProvider>
  );
}
