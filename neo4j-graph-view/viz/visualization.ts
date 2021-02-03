import type {IAdvancedGraphSettings} from '../settings';
import {EventRef, Events, ItemView, MarkdownRenderer, Menu, TFile, Vault, Workspace, WorkspaceLeaf} from 'obsidian';
import type AdvancedGraphPlugin from '../main';
import cytoscape, {
  Collection,
  Core,
  EdgeDefinition,
  EdgeSingular,
  ElementDefinition, LayoutOptions, Layouts,
  NodeCollection,
  NodeDefinition,
  NodeSingular, Singular,
} from 'cytoscape';
import type {IAGMode, IDataStore} from '../interfaces';
import {GraphStyleSheet} from './stylesheet';
import Timeout = NodeJS.Timeout;

import Toolbar from '../ui/Toolbar.svelte';
import {WorkspaceMode} from './workspace-mode';


export const AG_VIEW_TYPE = 'advanced_graph_view';
export const MD_VIEW_TYPE = 'markdown';

export const PROP_VAULT = 'SMD_vault';
export const PROP_PATH = 'SMD_path';

export const CLASS_PINNED = 'pinned';
export const CLASS_EXPANDED = 'expanded';

export const VIEWPORT_ANIMATION_TIME = 250;
export const LAYOUT_ANIMATION_TIME = 1500;

export const COSE_LAYOUT = {
  name: 'cose-bilkent',
  ready: function() {
    console.log('ready!');
  },
  stop: function() {
    console.log('stop!');
  },
  // @ts-ignore
  animate: 'end',
  animationDuration: 1000,
  refresh: 20,
  numIter: 5000,
  // @ts-ignore
  nodeRepulsion: 7000,
  // @ts-ignore
  idealEdgeLength: 80,
  // @ts-ignore
  edgeElasticity: 0.45,
  coolingFactor: 0.99,
  nodeDimensionsIncludeLabels: true,
  nestingFactor: 0.1,
  gravity: 0.25,
  tile: true,
};


let VIEW_COUNTER = 0;

export class VizId {
    id: string;
    storeId: string;
    constructor(id: string, storeId: string) {
      this.id = id;
      this.storeId = storeId;
    }

    toString(): string {
      return `${this.storeId}:${this.id}`;
    }

    toId(): string {
      return this.toString();
    }

    static fromId(id: string): VizId {
      const split = id.split(':');
      const storeId = split[0];
      const _id = split.slice(1).join(':');
      return new VizId(_id, storeId);
    }

    static fromNode(node: NodeSingular): VizId {
      return VizId.fromId(node.id());
    }

    static fromNodes(nodes: NodeCollection) : VizId[] {
      return nodes.map((n) => VizId.fromNode(n));
    }

    static fromFile(file: TFile): VizId {
      const name = file.extension === 'md' ? file.basename : file.name;
      return new VizId(name, 'core');
    }

    static fromPath(path: string): VizId {
      const pth = require('path');
      const name = pth.basename(path, '.md');
      return new VizId(name, 'core');
    }

    static toId(id: string, storeId: string) : string {
      return new VizId(id, storeId).toId();
    }
}

type AGMode = 'workspace' | 'local';

export class AdvancedGraphView extends ItemView {
    workspace: Workspace;
    settings: IAdvancedGraphSettings;
    initialNode: string;
    vault: Vault;
    plugin: AdvancedGraphPlugin;
    viz: Core;
    rebuildRelations = true;
    selectName: string = undefined;
    events: Events;
    datastores: IDataStore[];
    activeLayout: Layouts;
    hoverTimeout: Record<string, Timeout> = {};
    mode: IAGMode;

    constructor(leaf: WorkspaceLeaf, plugin: AdvancedGraphPlugin, initialNode: string, dataStores: IDataStore[]) {
      super(leaf);
      // TODO: Maybe make this configurable
      leaf.setPinned(true);
      this.settings = plugin.settings;
      this.workspace = this.app.workspace;
      this.initialNode = initialNode;
      this.vault = this.app.vault;
      this.plugin = plugin;
      this.datastores = dataStores;
      this.events = new Events();
      this.mode = new WorkspaceMode();
    }

    async onOpen() {
      const viewContent = this.containerEl.children[1];
      viewContent.addClass('cy-content');
      // Ensure the canvas fits the whole container
      viewContent.setAttr('style', 'padding: 0');
      this.createToolbar(viewContent);

      const div = document.createElement('div');
      div.id = 'cy' + VIEW_COUNTER;
      viewContent.appendChild(div);
      div.setAttr('style', 'height: 100%; width:100%');
      div.setAttr('tabindex', '0');


      const idInitial = new VizId(this.initialNode, 'core');

      const nodes = await this.neighbourhood([idInitial]);

      this.viz = cytoscape({
        container: div,
        elements: nodes,
        minZoom: 8e-1,
        maxZoom: 1.3e1,
      });
      this.viz.dblclick();

      if (this.settings.navigator) {
        const navDiv = document.createElement('div');
        navDiv.id = 'cynav' + VIEW_COUNTER;
        div.children[0].appendChild(navDiv);
        navDiv.addClass('cy-navigator');
        // @ts-ignore
        this.viz.navigator({//
          container: '#cynav' + VIEW_COUNTER,
          viewLiveFramerate: 0, // set false to update graph pan only on drag end; set 0 to do it instantly; set a number (frames per second) to update not more than N times per second
          thumbnailEventFramerate: 10, // max thumbnail's updates per second triggered by graph updates
          thumbnailLiveFramerate: false, // max thumbnail's updates per second. Set false to disable
          dblClickDelay: 200, // milliseconds
          removeCustomContainer: true, // destroy the container specified by user on plugin destroy
          rerenderDelay: 100, // ms to throttle rerender updates to the panzoom for performance
        });
      }
      VIEW_COUNTER += 1;

      this.trigger('vizReady', this.viz);

      this.viz.$id(idInitial.toId()).addClass(CLASS_EXPANDED);

      const nodez = this.viz.nodes();
      const edges = await this.buildEdges(nodez);

      this.viz.add(edges);
      this.onGraphChanged(true);

      if (this.settings.debug) {
        console.log(nodes);
        console.log(edges);
      }

      const styleSheet = await this.createStylesheet();
      this.viz.style(styleSheet);

      this.activeLayout = this.viz.layout(this.colaLayout()).start();

      console.log('Visualization ready');

      const view = this;

      this.viz.on('tap', 'node', async (e) => {
        const id = VizId.fromNode(e.target);
        if (!(id.storeId === 'core')) {
          return;
        }
        const file = this.app.metadataCache.getFirstLinkpathDest(id.id, '');
        if (file) {
          await this.plugin.openFile(file);
        } else {
          // Create dangling file
          // TODO: Add default folder
          const filename = id.id + '.md';
          const createdFile = await this.vault.create(filename, '');
          await this.plugin.openFile(createdFile);
        }
        this.updateActiveFile(e.target, true);
      });
      this.viz.on('tap', 'edge', async (e) => {

        // TODO: Move to correct spot in the file.
      });
      this.viz.on('dblclick', 'node', async (e) => {
        await this.expand(e.target as NodeSingular);
      });
      this.viz.on('mouseover', 'node', async (e) => {
        e.target.unlock();
        const node = e.target as NodeSingular;
        e.cy.elements()
            .difference(node.closedNeighborhood())
            .addClass('unhover');
        node.addClass('hover')
            .connectedEdges()
            .addClass('connected-hover')
            .connectedNodes()
            .addClass('connected-hover');

        const id = VizId.fromNode(e.target);
        if (id.storeId === 'core') {
          const file = this.plugin.metadata.getFirstLinkpathDest(id.id, '');
          if (file && file.extension === 'md') {
            const content = await view.vault.cachedRead(file);
            this.hoverTimeout[e.target.id()] = setTimeout(async () =>
              await this.popover(content, file.path, e.target, 'advanced-graph-preview-node'),
            500);
          }
        }
      });
      this.viz.on('mouseover', 'edge', async (e) => {
        const edge = e.target as EdgeSingular;
        e.cy.elements()
            .difference(edge.connectedNodes().union(edge))
            .addClass('unhover');
        edge.addClass('hover')
            .connectedNodes()
            .addClass('connected-hover');
        if ('context' in edge.data()) {// && e.originalEvent.metaKey) {
          // TODO resolve SourcePath, can be done using the source file.
          this.hoverTimeout[e.target.id()] = setTimeout(async () =>
          // @ts-ignore
            await this.popover(edge.data()['context'], '', edge, 'advanced-graph-preview-edge'),
          500);
        }
      });
      this.viz.on('mouseout', (e) => {
        if (e.target === e.cy) {
          return;
        }
        const id = e.target.id();
        if (id in this.hoverTimeout) {
          clearTimeout(this.hoverTimeout[id]);
          this.hoverTimeout[id] = undefined;
        }
        e.cy.elements().removeClass(['hover', 'unhover', 'connected-hover']);
        if (e.target.hasClass(CLASS_PINNED)) {
          e.target.lock();
        }
      });
      this.viz.on('grab', (e) => {
        if (this.activeLayout) {
          this.activeLayout.stop();
        }
      });
      this.viz.on('dragfree', (e) => {
        if (this.activeLayout) {
          this.activeLayout.stop();
        }
        // this.activeLayout = this.viz.layout(this.colaLayout()).start();
        this.activeLayout.start();
        const node = e.target;
        node.lock();
        this.activeLayout.one('layoutstop', (e)=> {
          if (!node.hasClass(CLASS_PINNED)) {
            node.unlock();
          }
        });
      });
      this.viz.on('cxttap', (e) =>{
        // Thanks Liam for sharing how to do context menus
        const fileMenu = new Menu(); // Creates empty file menu
        if (!(e.target === this.viz) && e.target.group() === 'nodes') {
          const id = VizId.fromNode(e.target);
          e.target.select();
          const file = this.app.metadataCache.getFirstLinkpathDest(id.id, '');
          if (!(file === undefined)) {
            // hook for plugins to populate menu with "file-aware" menu items
            this.app.workspace.trigger('file-menu', fileMenu, file, 'my-context-menu', null);
          }
        }
        const selection = view.viz.nodes(':selected');
        if (selection.length > 0) {
          fileMenu.addItem((item) => {
            item.setTitle('Expand selection (E)').setIcon('ag-expand')
                .onClick((evt) => {
                  this.expandSelection();
                });
          });
          fileMenu.addItem((item) => {
            item.setTitle('Hide selection (H)').setIcon('ag-hide')
                .onClick((evt) => {
                  this.removeSelection();
                });
          });
          fileMenu.addItem((item) =>{
            item.setTitle('Select all (A)').setIcon('ag-select-all')
                .onClick((evt) => {
                  this.selectAll();
                });
          });
          fileMenu.addItem((item) => {
            item.setTitle('Invert selection (I)').setIcon('ag-select-inverse')
                .onClick((evt) => {
                  this.invertSelection();
                });
          });
        }
        if (selection.length > 0) {
          fileMenu.addItem((item) => {
            item.setTitle('Select neighbors (N)').setIcon('ag-select-neighbors')
                .onClick((evt) => {
                  this.selectNeighbourhood();
                });
          });
          const pinned = this.getPinned();
          if (selection.difference(pinned).length > 0) {
            fileMenu.addItem((item) => {
              item.setTitle('Pin selection (P)').setIcon('ag-lock')
                  .onClick((evt) => {
                    this.pinSelection();
                  });
            });
          }
          if (selection.intersect(pinned).length > 0) {
            fileMenu.addItem((item) => {
              item.setTitle('Unpin selection (U)').setIcon('ag-unlock')
                  .onClick((evt) => {
                    this.unpinSelection();
                  });
            });
          }
          // use 'info' for pinning the preview. or  'popup-open'
        }
        fileMenu.showAtPosition({x: e.originalEvent.x, y: e.originalEvent.y});
      });
      this.viz.on('tapselect tapunselect boxselect', (e) => {
        this.trigger('selectChange');
      });
      this.viz.on('layoutstop', (e) => {
        const activeFile = this.viz.nodes('.active-file');
        if (activeFile.length > 0) {
          e.cy.animate({
            fit: {
              eles: activeFile.closedNeighborhood(),
              padding: 0,
            },
            duration: VIEWPORT_ANIMATION_TIME,
            queue: false,
          });
        }
      });
      // Register on file open event
      this.registerEvent(this.workspace.on('file-open', async (file) => {
        if (file && this.settings.autoAddNodes) {
          const name = file.basename;
          const id = new VizId(name, 'core');
          let followImmediate = true;
          if (this.viz.$id(id.toId()).length === 0) {
            for (const dataStore of this.datastores) {
              if (dataStore.storeId() === 'core') {
                const node = await dataStore.get(id);
                this.viz.startBatch();
                this.viz.add(node);
                const edges = await this.buildEdges(this.viz.$id(id.toId()));
                this.viz.add(edges);
                this.onGraphChanged(false);
                this.viz.endBatch();
                this.restartLayout();
                followImmediate = false;
                break;
              }
            }
          }
          const node = this.viz.$id(id.toId()) as NodeSingular;

          this.updateActiveFile(node, followImmediate);
        }
      }));

      // // Register keypress event
      // Note: Registered on window because it wouldn't fire on the div...
      window.addEventListener('keydown', (evt) => {
        if (!(this.workspace.activeLeaf === this.leaf)) {
          return;
        }
        if (evt.key === 'e') {
          this.expandSelection();
        } else if (evt.key === 'h' || evt.key === 'Backspace') {
          this.removeSelection();
        } else if (evt.key === 'i') {
          this.invertSelection();
        } else if (evt.key === 'a') {
          this.selectAll();
        } else if (evt.key === 'n') {
          this.selectNeighbourhood();
        } else if (evt.key === 'p') {
          this.pinSelection();
        } else if (evt.key === 'u') {
          this.unpinSelection();
        }
      }, true);


      // // Note: Nothing is implemented for on('createNode'). Is it true nothing should happen?
      // this.events.push(this.plugin.neo4jStream.on('renameNode', (o, n) => {
      //   this.onNodeRenamed(o, n);
      // }));
      // this.events.push(this.plugin.neo4jStream.on('modifyNode', (name) => {
      //   this.onNodeModify(name);
      // }));
      // this.events.push(this.plugin.neo4jStream.on('deleteNode', (name) => {
      //   this.onNodeDeleted(name);
      // }));
      //
    }

    async popover(mdContent: string, sourcePath: string, target: Singular, styleClass: string) {
      const newDiv = document.createElement('div');
      newDiv.addClasses(['popover', 'hover-popover', 'is-loaded', 'advanced-graph-hover']);
      const mdEmbedDiv = document.createElement('div');
      mdEmbedDiv.addClasses(['markdown-embed', styleClass]);
      newDiv.appendChild(mdEmbedDiv);
      const mdEmbedContentDiv = document.createElement('div');
      mdEmbedContentDiv.addClasses(['markdown-embed-content']);
      mdEmbedDiv.appendChild(mdEmbedContentDiv);
      const mdPreviewView = document.createElement('div');
      mdPreviewView.addClasses(['markdown-preview-view']);
      mdEmbedContentDiv.appendChild(mdPreviewView);
      const mdPreviewSection = document.createElement('div');
      mdPreviewSection.addClasses(['markdown-preview-sizer', 'markdown-preview-section']);
      mdPreviewView.appendChild(mdPreviewSection);


      await MarkdownRenderer.renderMarkdown(mdContent, mdPreviewSection, sourcePath, null );

      document.body.appendChild(newDiv);
      // @ts-ignore
      const popper = target.popper({
        content: () => {
          return newDiv;
        },
        popper: {
          placement: 'top',
        }, // my popper options here
      });
      const updatePopper = function() {
        popper.update();
      };
      target.on('position', updatePopper);
      this.viz.on('pan zoom resize', updatePopper);
      newDiv.addEventListener('mouseenter', (e) => {
        newDiv.addClass('popover-hovered');
      });
      newDiv.addEventListener('mouseleave', (e) => {
        popper.destroy();
        newDiv.remove();
      });
      this.viz.one('mouseout', (e) => {
        setTimeout(function() {
          if (!newDiv.hasClass('popover-hovered')) {
            popper.destroy();
            newDiv.remove();
          }
        }, 300);
      });
    }

    async neighbourhood(toExpand: VizId[]) : Promise<NodeDefinition[]> {
      const nodes: NodeDefinition[] = [];
      for (const store of this.datastores) {
        nodes.push(...await store.getNeighbourhood(toExpand));
      }
      return nodes;
    }

    async buildEdges(newNodes: NodeCollection): Promise<EdgeDefinition[]> {
      const edges: EdgeDefinition[] = [];
      for (const store of this.datastores) {
        edges.push(...await store.connectNodes(this.viz.nodes(), newNodes));
      }
      return edges;
    }

    async expand(toExpand: NodeCollection): Promise<Collection> {
      // Currently returns the edges merged into the graph, not the full neighborhood
      const expandedIds = toExpand.map((n) => VizId.fromNode(n));
      const neighbourhood = await this.neighbourhood(expandedIds);
      this.mergeToGraph(neighbourhood);
      const nodes = this.viz.collection();
      neighbourhood.forEach((n) => {
        nodes.merge(this.viz.$id(n.data.id) as NodeSingular);
      });
      const edges = await this.buildEdges(nodes);
      const edgesInGraph = this.mergeToGraph(edges);
      this.restartLayout();
      toExpand.addClass(CLASS_EXPANDED);
      this.updateActiveFile(toExpand, false);
      this.trigger('expand', toExpand);
      return edgesInGraph;
    }

    async createStylesheet(): Promise<string> {
      const sheet = new GraphStyleSheet(this.plugin);
      this.trigger('stylesheet', sheet);
      return await sheet.getStylesheet();
    }

    createToolbar(element: Element) {
      const tb = new Toolbar({
        target: element,
        props: {
          viz: this.viz,
          expandClick: this.expandSelection.bind(this),
          hideClick: this.removeSelection.bind(this),
          selectAllClick: this.selectAll.bind(this),
          selectInvertClick: this.invertSelection.bind(this),
          selectNeighborClick: this.selectNeighbourhood.bind(this),
          lockClick: this.pinSelection.bind(this),
          unlockClick: this.unpinSelection.bind(this),
          fitClick: this.fitView.bind(this),
        },
      });
      this.on('selectChange', tb.onSelect.bind(tb));
      this.on('vizReady', (viz) => {
        console.log(viz);
        tb.$set({viz: viz});
        tb.onSelect.bind(tb)();
        console.log(tb);
      });
    }

    protected async onClose(): Promise<void> {
    }

    // updateWithCypher(cypher: string) {
    //   if (this.settings.debug) {
    //     console.log(cypher);
    //   }
    //   // this.viz.updateWithCypher(cypher);
    //   this.rebuildRelations = true;
    // }

    async expandSelection() {
      await this.expand(this.viz.nodes(':selected'));
    }

    removeSelection() {
      const removed = this.removeNodes(this.viz.nodes(':selected'));
      this.trigger('hide', removed);
      this.trigger('selectChange');
    }

    selectAll() {
      this.viz.nodes().select();
      this.trigger('selectChange');
    }

    invertSelection() {
      this.viz.$(':selected')
          .unselect()
          .absoluteComplement()
          .select();
      this.trigger('selectChange');
    }

    selectNeighbourhood() {
      // TODO: This keeps self-loops selected.
      this.viz.nodes(':selected')
          .unselect()
          .openNeighborhood()
          .select();
      this.trigger('selectChange');
    }


    removeNodes(nodes: NodeCollection): NodeCollection {
      // Only call this method if the node is forcefully removed from the graph, not when the node no longer exists
      // on the back-end. This is because of how it handles expanded.
      // Remove as expanded if a neighbour is removed from the graph.
      this.getExpanded()
          .intersection(nodes.neighborhood())
          .removeClass('expanded');
      const removed = nodes.remove();
      this.restartLayout();
      return removed;
    }

    unpinSelection() {
      const unlocked = this.viz.nodes(':selected')
          .unlock()
          .removeClass(CLASS_PINNED);
      this.restartLayout();
      this.trigger('unpin', unlocked);
    }

    pinSelection() {
      const locked = this.viz.nodes(':selected')
          .lock()
          .addClass(CLASS_PINNED);
      this.restartLayout();
      this.trigger('pin', locked);
    }

    fitView() {
      this.viz.fit();
    }

    // getInQuery(nodes: IdType[]): string {
    //   let query = 'IN [';
    //   let first = true;
    //   for (const id of nodes) {
    //     // @ts-ignore
    //     const title = this.findNodeRaw(id).properties['name'] as string;
    //     if (!first) {
    //       query += ', ';
    //     }
    //     query += '"' + title + '"';
    //     first = false;
    //   }
    //   query += ']';
    //   return query;
    // }

    colaLayout(): LayoutOptions {
      return {
        name: 'cola',
        // @ts-ignore
        animate: true, // whether to show the layout as it's running
        refresh: 2, // number of ticks per frame; higher is faster but more jerky
        maxSimulationTime: LAYOUT_ANIMATION_TIME, // max length in ms to run the layout
        ungrabifyWhileSimulating: false, // so you can't drag nodes during layout
        fit: false, // on every layout reposition of nodes, fit the viewport
        padding: 30, // padding around the simulation
        nodeDimensionsIncludeLabels: true, // whether labels should be included in determining the space used by a node
        // layout event callbacks
        ready: function() {
        }, // on layoutready
        stop: function() {
          // viz.activeLayout = null;
        }, // on layoutstop
        // positioning options
        randomize: false, // use random node positions at beginning of layout
        avoidOverlap: true, // if true, prevents overlap of node bounding boxes
        handleDisconnected: true, // if true, avoids disconnected components from overlapping
        convergenceThreshold: 0.01, // when the alpha value (system energy) falls below this value, the layout stops
        nodeSpacing: function( node: NodeSingular ) {
          return 10;
        }, // extra spacing around nodes
      };
    }

    restartLayout() {
      if (this.activeLayout) {
        this.activeLayout.stop();
      }
      this.activeLayout = this.viz.layout(this.colaLayout()).start();
    }

    mergeToGraph(elements: ElementDefinition[], batch=true): Collection {
      if (batch) {
        this.viz.startBatch();
      }
      const addElements: ElementDefinition[] = [];
      const mergedCollection = this.viz.collection();
      elements.forEach((n) => {
        if (this.viz.$id(n.data.id).length === 0) {
          addElements.push(n);
        } else {
          const gElement = this.viz.$id(n.data.id);
          const extraClasses = [];
          if (gElement.hasClass(CLASS_EXPANDED)) {
            extraClasses.push(CLASS_EXPANDED);
          }
          if (gElement.hasClass(CLASS_PINNED)) {
            extraClasses.push(CLASS_PINNED);
          }
          // TODO: Maybe make an event here
          gElement.classes(n.classes);
          for (const clazz of extraClasses) {
            gElement.addClass(clazz);
          }
          gElement.data(n.data);
          mergedCollection.merge(gElement);
          if (this.getExpanded().contains(gElement)) {
            gElement.addClass('expanded');
          }
        }
      });
      mergedCollection.merge(this.viz.add(addElements));
      this.onGraphChanged(false);
      if (batch) {
        this.viz.endBatch();
      }
      return mergedCollection;
    }

    onGraphChanged(batch:boolean=true) {
      if (batch) {
        this.viz.startBatch();
      }
      this.viz.nodes().forEach((node) => {
        node.data('degree', node.degree(false));
        node.data('nameLength', node.data('name').length);
        console.log(node.data());
      });
      if (batch) {
        this.viz.endBatch();
      }
    }

    public getViz(): Core {
      return this.viz;
    }


    getDisplayText(): string {
      return 'Advanced Graph';
    }

    getViewType(): string {
      return AG_VIEW_TYPE;
    }

    updateActiveFile(node: NodeCollection, followImmediate: boolean) {
      console.log('uaf');
      this.viz.elements()
          .removeClass(['connected-active-file', 'active-file', 'inactive-file'])
          .difference(node.closedNeighborhood())
          .addClass('inactive-file');
      node.addClass('active-file');
      const neighbourhood = node.connectedEdges()
          .addClass('connected-active-file')
          .connectedNodes()
          .addClass('connected-active-file')
          .union(node);
      if (followImmediate) {
        this.viz.animate({
          fit: {
            eles: neighbourhood,
            padding: 0,
          },
          duration: VIEWPORT_ANIMATION_TIME,
          queue: false,
          // step: () => {
          //   animation.fit(neighbourhood);
          // },
        });
      }
      this.viz.one('tap', (e) => {
        e.cy.elements().removeClass(['connected-active-file', 'active-file', 'inactive-file']);
      });
    }

    public getPinned() {
      return this.viz.nodes(`.${CLASS_PINNED}`);
    }

    public getExpanded() {
      return this.viz.nodes(`.${CLASS_EXPANDED}`);
    }

    on(name:'stylesheet', callback: (sheet: GraphStyleSheet) => any): EventRef;
    on(name: 'expand', callback: (elements: NodeCollection) => any): EventRef;
    on(name: 'hide', callback: (elements: NodeCollection) => any): EventRef;
    on(name: 'pin', callback: (elements: NodeCollection) => any): EventRef;
    on(name: 'unpin', callback: (elements: NodeCollection) => any): EventRef;
    on(name: 'selectChange', callback: () => any): EventRef;
    on(name: 'vizReady', callback: (viz: Core) => any): EventRef;
    on(name: string, callback: (...data: any) => any, ctx?: any): EventRef {
      return this.events.on(name, callback, ctx);
    }
    off(name: string, callback: (...data: any) => any): void {
      this.events.off(name, callback);
    }
    offref(ref: EventRef): void {
      this.events.offref(ref);
    }
    trigger(name: 'stylesheet', sheet: GraphStyleSheet): void;
    trigger(name: 'expand', elements: NodeCollection): void;
    trigger(name: 'hide', elements: NodeCollection): void;
    trigger(name: 'pin', elements: NodeCollection): void;
    trigger(name: 'unpin', elements: NodeCollection): void;
    trigger(name: 'selectChange'): void;
    trigger(name: 'vizReady', viz: Core): void;
    trigger(name: string, ...data: any[]): void {
      this.events.trigger(name, ...data);
    }
    tryTrigger(evt: EventRef, args: any[]): void {
      this.events.tryTrigger(evt, args);
    }
}