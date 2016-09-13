const Log = require( 'poetry/lib/methods/log.js' ),
    Server = require( 'poetry/lib/server.js' ),
    Events = require( 'poetry/lib/methods/events.js' ),
    http = require( 'http' ),
    Joi = require( 'joi' ),
    J2M = require( 'joi-to-markdown' );

let routes = {};

Server.register( [ {
    register: require( 'h2o2' )
} ], ( err ) => {
    if ( err ) throw err;

    Events.on( 'web:route', {}, ( route, sender ) => {

        let r = route.method + ' ' + route.path;
        let poetryPort = route.poetryPort || 8000;
        delete route.poetryPort;

        // New route
        if ( !routes[ r ] ) {

            Log.info( 'New route `' + r + '` registered for',
                sender.address + ':' + poetryPort );

            // Register the HOST ip
            routes[ r ] = [ sender.address + ':' + poetryPort ];

            // Add handler
            route.handler = handler( r );

            // Don't parse
            if ( !route.config ) route.config = {};
            if ( route.method.toUpperCase() != 'GET' && route.method.toUpperCase() != 'HEAD' )
                route.config.payload = {
                    parse: false
                };


            route.config.cors = {
                credentials: true,
                origin: [ '*' ]
            }

            // Cleanup query validation
            if ( route.config.validate && route.config.validate.query ) {

                if ( !route.config.plugins )
                    route.config.plugins = {};
                if ( !route.config.plugins[ 'query' ] )
                    route.config.plugins[ 'query' ] = route.config.validate.query;

                route.config.validate.query = undefined;

            }

            // Cleanup payload validation
            if ( route.config.validate && route.config.validate.payload ) {

                if ( !route.config.plugins )
                    route.config.plugins = {};
                if ( !route.config.plugins[ 'payload' ] )
                    route.config.plugins[ 'payload' ] = route.config.validate.payload

                route.config.validate.payload = undefined;

            }

            // Register to HAPI
            Server.route( route );

        }

        // Existing route -> load balancing
        else {

            Log.info( 'Balanced route `' + r + '` registered for', sender.address );

            // Add HOST ip
            if ( routes[ r ].indexOf( sender.address + ':' + poetryPort ) )
                routes[ r ].push( sender.address + ':' + poetryPort );

        }

    } );

    function handler( route ) {

        // Return the real handler
        return function ( req, reply ) {

            if ( !routes[ route ] || !routes[ route ].length )
                return reply( 503 );

            // Round robin'
            let node = routes[ route ].pop();
            routes[ route ].unshift( node );

            let host = node.split( ':' );

            reply.proxy( {
                host: host[ 0 ],
                port: host[ 1 ] || 8000,
                protocol: 'http',
                passThrough: true,
                onResponse: ( err, res, request, reply ) => {
                    reply( res )
                        .header( 'X-PoweredBy', 'Poetry' )
                        .header( 'X-MicroServ', node );

                    if ( err && err.code == 'ECONNREFUSED' )
                        healthCheck( node );
                }
            } );

        };

    }

    function healthCheck( node ) {

        // TODO healthCheck before cleaning

        Log.warn( 'Cleaned node', node );
        Object.keys( routes )
            .forEach( ( route ) => {
                let i = routes[ route ].indexOf( node );
                if ( ~i ) routes[ route ].splice( i, 1 );
            } );
        Events.emit( 'web:init' );

    }

    Server.route( {
        method: 'options',
        path: '/{p*}',
        config: {
            cors: {
                credentials: true,
                origin: [ '*' ]
            }
        },
        handler( request, reply ) {
            reply();
        }
    } )

    Server.route( {
        method: 'get',
        path: '/api',
        config: {
            description: 'API Documentation'
        },
        handler( request, reply ) {

            let base = request.headers.host || 'api';
            let routes = Server.table()[ 0 ].table;

            // Root Postman JSON object
            let doc = {
                id: base,
                name: base,
                description: JSON.stringify( Server.table()[ 0 ].info ),
                timestamp: Date.now(),
                owner: 'Poetry',
                order: [],
                remoteLink: "http://" + base + "/api",
                public: true,

                folders: [],
                requests: []

            };

            let folders = {};

            // Parse routes
            routes.forEach( ( route ) => {

                // Main properties
                let request = {
                    id: route.fingerprint,
                    name: route.settings.description || route.fingerprint,
                    description: ( route.settings.notes || [] )
                        .join( '\n\n' ),
                    collectionId: base,
                    method: route.method,
                    url: 'http://' + base + route.path,
                    dataMode: 'raw',
                    rawModeData: '',
                    headers: "Content-Type: application/json\n"
                }

                if ( route.settings.validate.params ) {
                    let params = route.settings.validate.params;
                    if ( !params.isJoi && typeof params === 'object' )
                        params = Joi.object( params );
                    request.description += '\n\n---\n\n**URL Params**\n';
                    request.description += J2M.convertSchema( params )
                        .md;
                }

                if ( route.settings.plugins.query ) {
                    let query = route.settings.plugins.query;
                    if ( !query.isJoi && typeof query === 'object' )
                        query = Joi.object( query );
                    request.description += '\n\n---\n\n**URL Variables**\n';
                    request.description += J2M.convertSchema( query )
                        .md;
                }

                if ( route.settings.plugins.payload ) {
                    let payload = route.settings.plugins.payload;
                    if ( !payload.isJoi && typeof payload === 'object' )
                        payload = Joi.object( payload );
                    payload = J2M.convertSchema( payload );
                    request.description += '\n\n---\n\n**Payload**\n';
                    request.description += payload.md.replace( /\s\[\+\d\s\]/g, '[]' );
                    var example = {};
                    if ( payload.records && payload.records.length )
                        payload.records.forEach( ( record ) => {

                            if ( !record.path ) return;

                            let setter = new Function( "example", "newval", "example." + record.path + " = newval; return example" );

                            if ( record.examples && record.examples.length )
                                return setter( example, record.examples[ 0 ] );

                            switch ( record.type ) {
                            case 'string':
                                example = setter( example, "" );
                                break;
                            case 'number':
                                example = setter( example, 0 );
                                break;
                            case 'array':
                                example = setter( example, [] );
                                break;
                            case 'object':
                                example = setter( example, {} );
                                break;
                            case 'date':
                                example = setter( example, Date.now() );
                                break;
                            default:
                                example = setter( example, null );
                            }
                        } );

                    request.rawModeData = JSON.stringify( example, null, 4 );
                }

                // If no tag, root
                if ( !route.settings.tags || !route.settings.tags.length )
                    return doc.requests.push( request );

                // For each tag, add it
                route.settings.tags.forEach( ( tag ) => {
                    let r = {};
                    Object.keys( request )
                        .forEach( ( key ) => {
                            r[ key ] = request[ key ];
                        } );
                    r.folder = tag;
                    r.id += '#' + tag;
                    doc.requests.push( r );

                    // Create folder if new
                    if ( !folders[ tag ] )
                        folders[ tag ] = {
                            id: tag,
                            name: tag,
                            description: tag,
                            owner: 'Poetry',
                            order: [],
                            collectionId: base
                        };
                    // Add in folder
                    folders[ tag ].order.push( r.id );

                } );

            } );

            Object.keys( folders )
                .forEach( ( folder ) => {
                    doc.folders.push( folders[ folder ] );
                } );

            reply( doc );

        }
    } );

    Events.emit( 'web:init' );

} );

Object.resolve = function ( path, obj, safe ) {
    return path.split( '.' )
        .reduce( function ( prev, curr ) {
            return !safe ? prev[ curr ] : ( prev ? prev[ curr ] : undefined )
        }, obj || self )
}
