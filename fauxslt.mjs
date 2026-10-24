import MARKUP from 'markup-mixup';

// FauXSLT module

// class for template registry, namespaces etc

export class Registry {
    constructor () {
        // templates
        this.templates = new Map();
    }

    registerMatch (xpath, fn) {
    }

    registerNamed (name, fn) {
    }

    // replaces the node
    transform (node, params) {
        // pre-match and cache matches on templates

        // run the template that matches the node that first matches
        // the fewest nodes, second most recently added

        // replace the node with the result
    }
}

// class for the execution context that has the current node and result tree etc

export class Context {
    constructor (registry, node) {
        this.registry = registry;
        this.node     = node;
    }

    // return whatever it is
    select (xpath) {
    }

    // just test if the xpath matches
    test (xpath) {
        return !!this.select(xpath);
    }

    // apply templates to the nodes netted by the xpath expression
    applyTemplates (xpath, params) {
        // should return a DocumentFragment or whatever i guess
    }

    // call a named template on the current node
    callTemplate (name, params) {
    }
}
